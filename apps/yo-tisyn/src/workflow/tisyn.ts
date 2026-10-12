import type { Operation } from "effection";
import { createDurableTool, type AnyToolContract } from "@sweatpants/agent-sdk";
import type { DurableProgramContext, DurableTool } from "@sweatpants/durable-execution";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { z } from "zod";

import { MAX_SOURCE_LENGTH, parseTisynSource } from "./source.ts";
import { createEvaluation, EVALUATION_LIMITS } from "./evaluation/port.ts";
import type { TisynExpr } from "@tisyn/ir";
import packageJson from "../../package.json" with { type: "json" };

export type BoundTool = DurableTool & AnyToolContract;
const structural = new Set([
  "let",
  "seq",
  "if",
  "get",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "neg",
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
  "and",
  "or",
  "not",
  "construct",
  "array",
  "concat",
  "throw",
  "call",
  "while",
]);
const reserved = new Set([
  "try",
  "concat-arrays",
  "merge-objects",
  "all",
  "race",
  "scope",
  "spawn",
  "join",
  "resource",
  "provide",
  "timebox",
]);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
/** Fail closed before any tool can run, including effects inside unselected branches. */
export function parseProgram(source: string, tools: readonly BoundTool[]): TisynExpr {
  const ir = parseTisynSource(source);
  const names = new Set(tools.map((tool) => tool.name));
  const pending: unknown[] = [ir];
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++nodes > 1000) {
      throw new Error("Tisyn program exceeds 1000 values");
    }
    if (value === null || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 64) {
        throw new Error("Tisyn array exceeds 64 items");
      }
      pending.push(...value);
      continue;
    }
    const node = value as Record<string, unknown>;
    if (node.tisyn === "eval") {
      if (typeof node.id !== "string" || (!structural.has(node.id) && !names.has(node.id))) {
        throw new Error(`Unsupported Tisyn operation: ${String(node.id)}`);
      }
      if (structural.has(node.id)) {
        const data = node.data as Record<string, unknown> | null;
        const fields = data?.expr;
        if (
          !data ||
          data.tisyn !== "quote" ||
          !fields ||
          typeof fields !== "object" ||
          Array.isArray(fields) ||
          "tisyn" in fields
        ) {
          throw new Error(
            "Structural operations require static quoted fields; computed IR is not supported",
          );
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        unsafeKeys.has(key) ||
        (key === "key" && typeof child === "string" && unsafeKeys.has(child))
      ) {
        throw new Error("Prototype-related fields are outside this spike's profile");
      }
      pending.push(child);
    }
  }
  assertJson(ir);
  return ir;
}

/** Only descriptors cross into Sweatpants. Each tool remains a pinned child program. */
export function* executeProgram(
  source: string,
  tools: readonly BoundTool[],
  context: DurableProgramContext,
): Operation<Json> {
  const ir = parseProgram(source, tools);
  const registry = new Map(tools.map((tool) => [tool.name, tool]));
  const kernel = yield* createEvaluation(ir);
  let next = yield* kernel.next();
  let invocationId: string | undefined;
  let callIndex = 0;
  while (!next.done) {
    const descriptor = next.value;
    const tool = registry.get(descriptor.id);
    if (!tool) {
      throw new Error(`No Tisyn tool binding: ${descriptor.id}`);
    }
    const input = validateAuthoredSchema<Json>(tool.parameters, descriptor.data);
    if (input.status !== "ok") {
      throw new Error(`Invalid arguments for ${tool.name}: ${JSON.stringify(input)}`);
    }
    if (invocationId === undefined) {
      invocationId = yield* context.record(
        { key: "tisyn.invocation-id", retrySafety: { mode: "repeatable" } },
        function* (attempt) {
          return attempt.pullId;
        },
      );
    }
    // Chat correlates native child elicits with the start immediately before invoke.
    // The namespace comes from Sweatpants, never from model-authored source.
    const callId = `${invocationId}/tool-${callIndex++}`;
    yield* context.emit("tool_started", {
      callId,
      tool: tool.name,
      input: assertJson(input.value),
    });
    const value = yield* context.pull(
      assertJson({
        kind: "invoke",
        child: {
          id: tool.manifest.programId,
          version: tool.manifest.version,
          digest: tool.manifest.digest,
          input: assertJson(input.value),
        },
      }),
    );
    yield* context.emit("tool_completed", {
      callId,
      tool: tool.name,
      result: assertJson(value),
      failed: false,
    });
    // Errors/cancellation propagate unchanged; Try is intentionally not admitted yet.
    next = yield* kernel.next(assertJson(value));
  }
  const result = assertJson(next.value);
  if (canonicalJson(result).length > 32_768) {
    throw new Error("Tisyn result exceeds 32 KiB");
  }
  return result;
}

export interface EvaluationProfile {
  id: string;
  limits: Json;
  description: string;
}

export function createTisynTool(
  tools: readonly BoundTool[],
  profile: EvaluationProfile = {
    id: "yo-tisyn@0.0.1/profile-5-guarded-loops",
    limits: EVALUATION_LIMITS,
    description: `Limits: ${EVALUATION_LIMITS.toolCalls} tool calls per program; ${EVALUATION_LIMITS.stepMilliseconds} ms of synchronous evaluation between tool calls (human wait time is excluded). Limits fail explicitly; they are not successful completion. Recursion also has a JavaScript stack limit.`,
  },
) {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name) || structural.has(tool.name) || reserved.has(tool.name)) {
      throw new Error(`Duplicate or reserved Tisyn tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  const bindings = Object.freeze([...tools]);
  const contracts = bindings.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.artifacts.parameters.inputProjection,
    output: tool.artifacts.output?.outputProjection ?? null,
    elicits: Object.fromEntries(
      Object.entries(tool.artifacts.elicits).map(([key, value]) => [
        key,
        {
          response: value.response.inputProjection,
          context: value.context?.inputProjection ?? null,
        },
      ]),
    ),
  }));
  const description = [
    "Execute a small Tisyn workflow. This is the only tool you can call directly.",
    "The program is constructor DSL, NOT JavaScript. Use double-quoted strings.",
    'Eval("name", {"key": value}) calls a registered tool and returns its JSON result.',
    'Let("x", expression, body) binds a result. Ref("x") reads it. Get(expr, "key") reads an object field.',
    "Seq(a,b) runs in order and returns b. If(condition,then,else) chooses one branch.",
    'Construct({"key": expr}) evaluates object fields. Arr(a,b) builds an array. Plain objects elsewhere are literal data.',
    "Concat(a,b) joins strings. Add/Sub/Mul/Div and Eq/Gt/Lt operate on values. And/Or short-circuit.",
    "Available: JSON literals, Let, Ref, Seq, If, Get, Construct, Arr, Concat, arithmetic/comparisons, And/Or/Not, Throw.",
    'Fn(["parameter"], body) defines a function. Call(functionExpression, argument) calls it. Functions use the caller environment plus parameter bindings.',
    "A function bound by Let can call itself through Ref. Carry accumulated state as function parameters. Bindings are immutable; While(condition, [body]) does not mutate outer bindings.",
    'Recursion example: Let("countdown", Fn(["n"], If(Eq(Ref("n"),0),0,Call(Ref("countdown"),Sub(Ref("n"),1)))), Call(Ref("countdown"),3))',
    "For repetition, write ONE program with Fn/Call recursion or While. Keep all rounds inside that invocation until its stop condition. Do not unroll rounds or return to the model between rounds.",
    "For ask-driven repetition, branch on action. Accept continues; decline and cancel stop. Echo accumulated text after each accepted reply, not after stopping.",
    profile.description,
    "No Try, concurrency, computed IR, arbitrary JS, imports, or undeclared operations.",
    "Use a single program to carry values across tool calls. Human replies are returned by ask, not invented by you.",
    'Example: Let("x", Eval("echo", {"message":"hello"}), Eval("ask", {"message":Get(Ref("x"),"message")}))',
    "Registered tool contracts:",
    JSON.stringify(contracts),
  ].join("\n");
  return createDurableTool("tisyn")
    .description(description)
    .identity({
      version: "0.0.1",
      digest: sha256(
        canonicalJson({
          interpreter: profile.id,
          evaluationLimits: profile.limits,
          tisyn: Object.fromEntries(
            Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith("@tisyn/")),
          ),
          tools: bindings.map((tool) => ({
            name: tool.name,
            digest: tool.manifest.digest,
            interface: tool.interfaceDigest,
          })),
        }),
      ),
    })
    .parameters(z.object({ program: z.string().min(1).max(MAX_SOURCE_LENGTH) }))
    .execute(function* ({ program }, context) {
      return yield* executeProgram(program, bindings, context);
    });
}
