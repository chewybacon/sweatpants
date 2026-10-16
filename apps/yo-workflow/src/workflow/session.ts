import { sampleCompletion, samplingIdentity, samplingParameters } from "./sampling.ts";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { z } from "zod";
import { createEvaluation, EVALUATION_LIMITS } from "./evaluation/port.ts";
import { MAX_SOURCE_LENGTH } from "./source.ts";
import { parseProgram, type BoundTool } from "./tisyn.ts";
import { evaluateJsonValue, JSON_VALUE_OPERATION } from "./json-values.ts";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import kernelBundle from "./evaluation/generated/kernel-source.json" with { type: "json" };

const send = z
  .object({ sessionId: z.string(), turnId: z.number().int().positive(), message: z.json() })
  .strict();
const answer = z
  .object({
    sessionId: z.string(),
    turnId: z.number().int().positive(),
    requestId: z.string(),
    answer: z.json(),
  })
  .strict();
const close = z.object({ sessionId: z.string() }).strict();

/** One durable coordinator owns two pull-driven evaluators and their exchanges. */
export function createSessionTool(tools: readonly BoundTool[]) {
  if (tools.some((tool) => tool.name === "sample")) {
    throw new Error("sample is reserved for the native sampling capability");
  }
  return createDurableTool("session")
    .description(
      [
        "Run a parent and one persistent child Tisyn program. Supply parent and child as DSL source strings plus sessionId. Each runs in an isolated evaluator; only explicit messages cross. The child keeps its logical scope across turns and recovery. Both programs are validated before execution; validateOnly optionally returns validation without effects.",
        'Parent effects: Eval("session.send",{sessionId,turnId,message}) starts a turn (IDs start at 1 and increase by 1). Eval("session.answer",{sessionId,turnId,requestId,answer}) answers the outstanding question. Eval("session.close",{sessionId}) closes a ready child. Eval("session.cancel",{sessionId}) stops an open child, including one awaiting an answer.',
        'Child must begin with Eval("session.receive",{}), which returns {type:"message",message}. Eval("session.askParent",question) yields a question and receives the parent answer directly. Eval("session.turnResult",result) completes the turn and receives the NEXT {type:"message",message} or {type:"close"}. Carry state through Fn/Call recursion; on close RETURN a final summary. Returning is distinct from yielding a turn result.',
        'Parent commands return {kind:"question",sessionId,turnId,requestId,question}, {kind:"turnResult",sessionId,turnId,result}, {kind:"closed",sessionId,result}, or {kind:"cancelled",sessionId}. Branch on kind. For a question, answer it using code, sample, or ask. For a turnResult, send another turn or close. On a declined/cancelled ask, cancel the child and return accumulated progress. Parent must close or cancel an open child before returning.',
        "One turn and one question at a time. A handler is not a background agent. No mailbox or independent session endpoint. Limits: 64 exchanges, 256 ordinary tool calls, 32 KiB values. Ordinary effects and JSON helpers work in either program. Sampling context is explicit; no parent variables or transcript are inherited.",
        `Native capability: sample. Available ordinary tools: ${tools.map((tool) => tool.name).join(", ")}. Use their contracts from the enclosing Tisyn description.`,
      ].join("\n"),
    )
    .identity({
      version: "0.0.1",
      digest: sha256(
        canonicalJson({
          interpreter: "tisyn-session-v2",
          sampling: samplingIdentity,
          kernel: kernelBundle.provenance,
          limits: EVALUATION_LIMITS,
          tools: tools.map((tool) => ({
            name: tool.name,
            digest: tool.manifest.digest,
            interface: tool.interfaceDigest,
          })),
        }),
      ),
    })
    .parameters(
      z.object({
        parent: z.string().min(1).max(MAX_SOURCE_LENGTH),
        child: z.string().min(1).max(MAX_SOURCE_LENGTH),
        sessionId: z.string().min(1).max(128),
        validateOnly: z.boolean().optional(),
      }),
    )
    .samples()
    .execute(function* ({ parent, child, sessionId, validateOnly }, context) {
      const parentIr = parseProgram(parent, tools, true, false, [
        "session.send",
        "session.answer",
        "session.close",
        "session.cancel",
      ]);
      const childIr = parseProgram(child, tools, true, false, [
        "session.receive",
        "session.askParent",
        "session.turnResult",
      ]);
      if (validateOnly) {
        return { status: "valid", executed: false };
      }
      const invocationId = yield* context.record(
        { key: "session.invocation-id", retrySafety: { mode: "repeatable" } },
        function* (attempt) {
          return attempt.pullId;
        },
      );
      let toolCalls = 0;
      function bounded(value: unknown): Json {
        const json = assertJson(value);
        if (new TextEncoder().encode(canonicalJson(json)).length > 32768) {
          throw new Error("Session value exceeds 32 KiB");
        }
        return json;
      }
      function* invoke(id: string, input: Json, ctx: DurableProgramContext): Operation<Json> {
        if (id === JSON_VALUE_OPERATION) {
          return evaluateJsonValue(input);
        }
        if (++toolCalls > 256) {
          throw new Error("Session exceeded 256 tool calls");
        }
        const tool = tools.find((candidate) => candidate.name === id);
        if (!tool && id !== "sample") {
          throw new Error(`Unsupported session effect: ${id}`);
        }
        const parsed = validateAuthoredSchema<Json>(
          tool ? tool.parameters : samplingParameters,
          input,
        );
        if (parsed.status !== "ok") {
          throw new Error(`Invalid session tool arguments: ${id}`);
        }
        const callId = `${invocationId}/tool-${toolCalls}`;
        yield* ctx.emit("tool_started", { callId, tool: id, input: bounded(parsed.value) });
        const operation = tool
          ? ctx.pull({
              kind: "invoke",
              child: {
                id: tool.manifest.programId,
                version: tool.manifest.version,
                digest: tool.manifest.digest,
                input: parsed.value,
              },
            })
          : sampleCompletion(samplingParameters.parse(parsed.value), context, callId);
        const result = yield* operation;
        const value = bounded(result);
        yield* ctx.emit("tool_completed", { callId, tool: id, result: value, failed: false });
        return value;
      }
      const parentEvaluation = yield* createEvaluation(parentIr);
      const childEvaluation = yield* createEvaluation(childIr);
      let childStep = yield* childEvaluation.next();
      if (childStep.done || childStep.value.id !== "session.receive") {
        throw new Error("Child must initially receive a message");
      }
      let phase: "ready" | "question" | "closed" = "ready";
      let turnId = 0;
      let questions = 0;
      let requestId: string | undefined;
      let exchange = 0;
      let parentStep = yield* parentEvaluation.next();
      while (!parentStep.done) {
        const { id, data } = parentStep.value;
        if (!id.startsWith("session.")) {
          const value = yield* invoke(id, data, context);
          parentStep = yield* parentEvaluation.next(value);
          continue;
        }
        if (exchange >= 64) {
          throw new Error("Session exceeded 64 exchanges");
        }
        bounded(data);
        let input: Json;
        if (id === "session.send") {
          const command = send.parse(data);
          if (
            command.sessionId !== sessionId ||
            phase !== "ready" ||
            command.turnId !== turnId + 1
          ) {
            throw new Error("Send requires the next turn of a ready session");
          }
          turnId = command.turnId;
          questions = 0;
          input = { type: "message", message: command.message };
        } else if (id === "session.answer") {
          const command = answer.parse(data);
          if (
            command.sessionId !== sessionId ||
            phase !== "question" ||
            command.turnId !== turnId ||
            command.requestId !== requestId
          ) {
            throw new Error("Answer must match the outstanding question");
          }
          input = command.answer;
        } else if (id === "session.cancel") {
          const command = close.parse(data);
          if (command.sessionId !== sessionId || phase === "closed") {
            throw new Error("Cancel requires an open session");
          }
          phase = "closed";
          const event = { kind: "cancelled", sessionId };
          const entry = bounded({ command: { id, data }, event });
          const recorded = yield* context.record(
            { key: `session.exchange.${exchange++}`, retrySafety: { mode: "repeatable" } },
            function* () {
              return entry;
            },
          );
          if (canonicalJson(assertJson(recorded)) !== canonicalJson(entry)) {
            throw new Error("Session exchange changed during replay");
          }
          parentStep = yield* parentEvaluation.next(event);
          continue;
        } else if (id === "session.close") {
          const command = close.parse(data);
          if (command.sessionId !== sessionId || phase !== "ready") {
            throw new Error("Close requires a ready session");
          }
          input = { type: "close" };
        } else {
          throw new Error(`Unknown session command: ${id}`);
        }
        childStep = yield* childEvaluation.next(input);
        // Ordinary child effects retain normal pinned, journaled invocation semantics.
        while (!childStep.done && !childStep.value.id.startsWith("session.")) {
          const value = yield* invoke(childStep.value.id, childStep.value.data, context);
          childStep = yield* childEvaluation.next(value);
        }
        let event: Json;
        if (childStep.done) {
          phase = "closed";
          event = { kind: "closed", sessionId, result: childStep.value };
        } else if (id === "session.close") {
          throw new Error("Child must return when closed");
        } else if (childStep.value.id === "session.askParent") {
          phase = "question";
          requestId = `${turnId}/question-${++questions}`;
          event = {
            kind: "question",
            sessionId,
            turnId,
            requestId,
            question: childStep.value.data,
          };
        } else if (childStep.value.id === "session.turnResult") {
          phase = "ready";
          requestId = undefined;
          event = { kind: "turnResult", sessionId, turnId, result: childStep.value.data };
        } else {
          throw new Error(`Unexpected child session effect: ${childStep.value.id}`);
        }
        // Rebuild both continuations on replay, then check their exchange against
        // journal truth. Recording alone must not skip evaluator advancement.
        const entry = bounded({ command: { id, data }, event });
        const recorded = yield* context.record(
          { key: `session.exchange.${exchange++}`, retrySafety: { mode: "repeatable" } },
          function* () {
            return entry;
          },
        );
        if (canonicalJson(assertJson(recorded)) !== canonicalJson(entry)) {
          throw new Error("Session exchange changed during replay");
        }
        parentStep = yield* parentEvaluation.next(event);
      }
      if (phase !== "closed") {
        throw new Error("Parent returned with an open child session");
      }
      return bounded(parentStep.value);
    });
}
