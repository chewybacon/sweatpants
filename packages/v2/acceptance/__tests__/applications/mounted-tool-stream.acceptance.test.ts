import { createElicitationHandler } from "@sweatpan.ts/chat-client";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Outcome, Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery, type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  createJournalPresentation,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import {
  createToolAcquisition,
  createToolAdmission,
  defineTool,
  projectToolContract,
  installElicitHandlers,
  type ElicitHandlers,
} from "@sweatpan.ts/tools";
import {
  createResponseStreamRig,
  createSqliteJournalRig,
  type ResponseStreamRig,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
function textSchema<T>(transform: (value: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "mounted-tool-tracer",
      validate(value) {
        return typeof value === "string"
          ? { value: transform(value) }
          : { issues: [{ message: "Expected text" }] };
      },
    },
  };
}
// Mount, frames and client attachment below are provisional application composition,
// not public framework APIs. A transport frame carries data, never a reply closure.
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const disconnectAt of ["before-publication", "after-publication", "after-answer"] as const) {
    it(`${runtime.name}: mounted tool and typed client recover a stream disconnected ${disconnectAt}`, async () => {
      let acquisitions = 0;
      let disposals = 0;
      let records = 0;
      let stamped = 0;
      let defaultAnswers = 0;
      let clientCalls = 0;
      let contextParses = 0;
      let responseParses = 0;
      const stamp = defineEffect(
        { key: "streamed.stamp", context: textSchema((value) => value) },
        function* (value) {
          stamped++;
          return { ok: true as const, value };
        },
      );
      const approval = defineEffect(
        {
          key: "streamed.approval",
          context: textSchema((question) => {
            contextParses++;
            return { question };
          }),
          response: textSchema((answer) => {
            responseParses++;
            return { approved: answer === "yes" };
          }),
        },
        function* () {
          defaultAnswers++;
          return { ok: true as const, value: "yes" };
        },
      );
      const tool = defineTool("streamed-tool")
        .parameters(textSchema((value) => ({ topic: value })))
        .capabilities({ stamp })
        .elicits({ approval })
        .execute(function* (input, ctx) {
          const token = yield* ctx.record(function* () {
            records++;
            return { ok: true as const, value: "recorded-token" };
          });
          const marked = yield* ctx.capabilities.stamp(token.value);
          if (!marked.ok) {
            throw new Error("Stamp failed");
          }
          const answer = yield* ctx.elicit("approval", `Approve ${input.topic}?`);
          if (!answer.ok) {
            throw new Error("Declined");
          }
          return { token: marked.value, approved: answer.value.approved };
        });
      const authored = { ...tool, serverOnly: "not public" };
      const contract = projectToolContract(authored);
      expect(Object.keys(contract).sort()).toEqual([
        "call",
        "capabilities",
        "context",
        "elicits",
        "id",
        "response",
      ]);
      for (const definition of [contract.capabilities.stamp, contract.elicits.approval]) {
        expect(Object.keys(definition).sort()).toEqual(["call", "context", "id", "response"]);
        expect(Object.isFrozen(definition)).toBe(true);
      }
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.capabilities)).toBe(true);
      expect(Object.isFrozen(contract.elicits)).toBe(true);
      expect(contract.context).toBe(tool.context);
      expect(contract.call).toBe(tool.call);
      expect(contract.capabilities.stamp).not.toBe(stamp);
      expect(contract.elicits.approval).not.toBe(approval);
      expect(contract.elicits.approval.context).toBe(approval.context);
      expect(contract.elicits.approval.response).toBe(approval.response);
      expect({
        acquisitions,
        records,
        stamped,
        defaultAnswers,
        contextParses,
        responseParses,
      }).toEqual({
        acquisitions: 0,
        records: 0,
        stamped: 0,
        defaultAnswers: 0,
        contextParses: 0,
        responseParses: 0,
      });
      type Input = StandardSchemaV1.InferOutput<typeof tool.context>;
      type Result = {
        token: string;
        approved: boolean;
      };
      type Ask = {
        kind: "elicitation";
        tool: string;
        effect: string;
        grant: ResolutionGrant;
        input: unknown;
      };
      type Frame =
        | Ask
        | {
            kind: "completed";
            value: Result;
          };
      const store = createSqliteJournalRig<Result, CapabilityRequest, unknown, string, unknown, Y>({
        program: tool.id,
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      function start<T>(work: Work<T, Y>) {
        const execution = runtime.start(work);
        void execution.result.catch(() => undefined);
        onTestFinished(() => execution.cancel());
        return execution;
      }
      function stream() {
        const value = createResponseStreamRig<Frame>();
        onTestFinished(() => value.disconnect());
        return value;
      }
      function mount() {
        const journal = store.open();
        const presentation = createJournalPresentation(
          runtime.composition,
          "mount-presentation",
          journal,
        );
        const admission = createToolAdmission(runtime, "mount-admission", tool, journal);
        const effects = createEffectCapabilities(runtime, "streamed-effects");
        const acquisition = createToolAcquisition(runtime, effects, tool, "streamed-acquisition");
        const recovery = createRecovery(runtime.composition, {
          name: "streamed-recovery",
          program: tool.id,
          matches: isDeepStrictEqual,
          *acquire() {
            const snapshot = yield* journal.read();
            if (!snapshot.admission) {
              throw new Error("Invocation not admitted");
            }
            acquisitions++;
            yield* runtime.composition.ensure(function* () {
              disposals++;
            });
            return yield* acquisition.operations.acquire(snapshot.admission.input as Input);
          },
        });
        const host = createHosting(runtime.composition, {
          name: "streamed-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: acquisition.handle,
        });
        function* run() {
          yield* effects.install(stamp);
          yield* host.around({
            operations: acquisition.admission,
          });
          yield* installElicitHandlers(host, effects, tool);
          yield* installGuestRetention(runtime.composition, host, recovery, journal);
          return yield* host.operations.run();
        }
        // Re-present existing registration/terminal state without acquiring a Guest.
        // Only a boundary that still needs advancement enters hosting.
        async function connect(connection: ResponseStreamRig<Frame>) {
          let page = await start(() => presentation.operations.read()).result;
          if (page.state.status === "running" && !page.state.interaction) {
            await start(run).result;
            page = await start(() => presentation.operations.read()).result;
          }
          expect(acquisitions).toBe(disposals);
          const state = page.state;
          if (
            state.status === "running" &&
            state.interaction?.state === "waiting" &&
            state.pending
          ) {
            connection.publish({
              kind: "elicitation",
              tool: tool.id,
              effect: state.pending.request.effect,
              grant: state.interaction.grant,
              input: state.pending.request.input,
            });
          } else if (state.status === "completed") {
            connection.publish({ kind: "completed", value: state.value });
          } else {
            throw new Error(`Unexpected mount state: ${state.status}`);
          }
        }
        return {
          async invoke(input: string, connection: ResponseStreamRig<Frame>) {
            await start(() => admission.operations.admit(input)).result;
            await connect(connection);
          },
          connect,
          answer(grant: ResolutionGrant, outcome: Outcome<unknown, unknown>) {
            return start(function* () {
              const answers = yield* installEffectAnswers(
                host,
                effects.grant(tool.elicits),
                journal.interactions,
              );
              return yield* answers.answer(grant, outcome);
            }).result;
          },
        };
      }
      // Client registration is independent of mount. This concrete one-effect tracer
      // receives only the projected contract for dispatch and context validation.
      function onElicit(
        view: typeof contract,
        handlers: ElicitHandlers<typeof contract.elicits, Y>,
      ) {
        const replies = new Map<string, Outcome<string, unknown>>();
        const handler = createElicitationHandler<
          {
            question: string;
          },
          string,
          unknown,
          Y
        >(runtime.composition, "client-approval", {
          *handle() {
            throw new Error("Client handler not installed");
          },
        });
        return async (frame: Ask) => {
          if (frame.tool !== view.id || frame.effect !== view.elicits.approval.id) {
            throw new Error("Unknown client interaction");
          }
          const prior = replies.get(frame.grant.resolutionId);
          if (prior) {
            return prior;
          }
          const parsed = await view.elicits.approval.context["~standard"].validate(frame.input);
          if (parsed.issues) {
            throw new Error("Invalid client context");
          }
          if (!handlers.approval) {
            throw new Error("Client handler missing");
          }
          const handle = handlers.approval;
          const value = await start(function* () {
            yield* handler.install({
              operations: { handle },
            });
            return yield* handler.operations.handle(parsed.value);
          }).result;
          replies.set(frame.grant.resolutionId, value);
          return value;
        };
      }
      const client = onElicit(contract, {
        *approval(context) {
          expectTypeOf(context).toEqualTypeOf<{
            question: string;
          }>();
          expect(context.question).toBe("Approve deploy?");
          clientCalls++;
          return { ok: true, value: "yes" };
        },
      });
      let mounted = mount();
      const first = stream();
      let original: Ask | undefined;
      if (disconnectAt === "before-publication") {
        first.disconnect();
        await expect(mounted.invoke("deploy", first)).rejects.toThrow(
          "Response stream disconnected",
        );
      } else {
        const publishing = mounted.invoke("deploy", first);
        const event = await first.read();
        if (event.done || event.value.kind !== "elicitation") {
          throw new Error("Expected client request");
        }
        original = event.value;
        // Fast answer is valid immediately upon observing the frame: registration preceded publication.
        if (disconnectAt === "after-answer") {
          const answer = await client(original);
          expect((await mounted.answer(original.grant, answer)).duplicate).toBe(false);
          // Simulated lost acknowledgement: client retains the same answer for retry.
        }
        await publishing;
        first.disconnect();
      }
      expect(acquisitions).toBe(disposals);
      expect(records).toBe(1);
      store.reopen();
      mounted = mount();
      const second = stream();
      if (disconnectAt !== "after-answer") {
        const beforeReconnect = acquisitions;
        await mounted.connect(second);
        expect(acquisitions).toBe(beforeReconnect);
        const event = await second.read();
        if (event.done || event.value.kind !== "elicitation") {
          throw new Error("Expected repeated request");
        }
        if (original) {
          expect(event.value).toEqual(original);
        }
        original = event.value;
        expect(contextParses).toBe(0); // Host forwarding did not execute or parse a handler.
        const answer = await client(original);
        const beforeAnswer = acquisitions;
        await expect(mounted.answer(original.grant, { ok: true, value: 123 })).rejects.toThrow(
          "Effect schema rejected value",
        );
        expect((await mounted.answer(original.grant, answer)).duplicate).toBe(false);
        expect(acquisitions).toBe(beforeAnswer); // Answer ingress does not resume the Guest.
      }
      if (!original) {
        throw new Error("Missing registered interaction");
      }
      const sameAnswer = await client(original);
      expect((await mounted.answer(original.grant, sameAnswer)).duplicate).toBe(true);
      store.reopen();
      mounted = mount();
      await mounted.connect(second);
      const completed = await second.read();
      expect(completed).toEqual({
        done: false,
        value: { kind: "completed", value: { token: "recorded-token", approved: true } },
      });
      expect({ records, clientCalls, contextParses, responseParses }).toEqual({
        records: 1,
        clientCalls: 1,
        contextParses: 1,
        responseParses: 2,
      });
      expect(stamped).toBe(1); // Original server default runs once, never during projection or replay.
      expect(defaultAnswers).toBe(0); // Participant policy does not install the elicitation default.
      expect(acquisitions).toBe(disposals);
    });
  }
});
