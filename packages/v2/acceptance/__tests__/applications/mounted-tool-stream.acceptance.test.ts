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
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import {
  createToolAcquisition,
  createToolAdmission,
  defineTool,
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
      let clientCalls = 0;
      let contextParses = 0;
      let responseParses = 0;
      const approval = defineEffect({
        key: "streamed.approval",
        context: textSchema((question) => {
          contextParses++;
          return { question };
        }),
        response: textSchema((answer) => {
          responseParses++;
          return { approved: answer === "yes" };
        }),
      });
      const tool = defineTool("streamed-tool")
        .parameters(textSchema((value) => ({ topic: value })))
        .elicits({ approval })
        .execute(function* (input, ctx) {
          const token = yield* ctx.record(function* () {
            records++;
            return { ok: true as const, value: "recorded-token" };
          });
          const answer = yield* ctx.elicit("approval", `Approve ${input.topic}?`);
          if (!answer.ok) {
            throw new Error("Declined");
          }
          return { token: token.value, approved: answer.value.approved };
        });
      type Input = StandardSchemaV1.InferOutput<typeof tool.context>;
      type Result = { token: string; approved: boolean };
      type Ask = {
        kind: "elicitation";
        tool: string;
        effect: string;
        grant: ResolutionGrant;
        input: unknown;
      };
      type Frame = Ask | { kind: "completed"; value: Result };
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
          yield* host.around(acquisition.admission);
          yield* installElicitHandlers(host, effects, tool);
          yield* installGuestRetention(runtime.composition, host, recovery, journal);
          return yield* host.operations.run();
        }
        // Transport owns publication AFTER run has registered the wait and released the Guest.
        async function connect(connection: ResponseStreamRig<Frame>) {
          const result = await start(run).result;
          expect(acquisitions).toBe(disposals);
          if (result.state === "waiting") {
            connection.publish({
              kind: "elicitation",
              tool: tool.id,
              effect: result.pending.request.effect,
              grant: result.grant,
              input: result.pending.request.input,
            });
          } else if (result.state === "completed") {
            connection.publish({ kind: "completed", value: result.value });
          } else {
            throw new Error(`Unexpected mount result: ${result.state}`);
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
      // uses the declaration only for dispatch and context validation, never its body.
      function onElicit(handlers: ElicitHandlers<typeof tool.elicits, Y>) {
        const replies = new Map<string, Outcome<string, unknown>>();
        const handler = createElicitationHandler<{ question: string }, string, unknown, Y>(
          runtime.composition,
          "client-approval",
          {
            *handle() {
              throw new Error("Client handler not installed");
            },
          },
        );
        return async (frame: Ask) => {
          if (frame.tool !== tool.id || frame.effect !== approval.id) {
            throw new Error("Unknown client interaction");
          }
          const prior = replies.get(frame.grant.resolutionId);
          if (prior) {
            return prior;
          }
          const parsed = await approval.context["~standard"].validate(frame.input);
          if (parsed.issues) {
            throw new Error("Invalid client context");
          }
          if (!handlers.approval) {
            throw new Error("Client handler missing");
          }
          const handle = handlers.approval;
          const value = await start(function* () {
            yield* handler.install({ handle });
            return yield* handler.operations.handle(parsed.value);
          }).result;
          replies.set(frame.grant.resolutionId, value);
          return value;
        };
      }
      const client = onElicit({
        *approval(context) {
          expectTypeOf(context).toEqualTypeOf<{ question: string }>();
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
        await mounted.connect(second);
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
      expect(acquisitions).toBe(disposals);
    });
  }
});
