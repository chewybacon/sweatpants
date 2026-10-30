import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import { admitTool, createToolAcquisition, defineTool } from "@sweatpan.ts/tools";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  for (const cancel of [false, true]) {
    it(`${runtime.name}: scoped root acquisition reuses admitted input and recorded values across reopen (cancel ${cancel})`, async () => {
      let validations = 0;
      let recorded = 0;
      let reads = 0;
      let cleaned = 0;
      let acquired = 0;
      let disposed = 0;
      const read = defineEffect({
        key: "acquisition.read",
        context: z.string(),
        response: z.string(),
      });
      const approve = defineEffect({
        key: "acquisition.approve",
        context: z.string(),
        response: z.string().transform((value) => value === "yes"),
      });
      const tool = defineTool("acquisition-root:v1")
        .parameters(
          z.string().transform((value) => {
            validations++;
            return { query: value.toLowerCase() };
          }),
        )
        // Equal aliases must not make one declaration hide the other.
        .capabilities({ lookup: read })
        .elicits({ lookup: approve })
        .execute(function* (input, ctx) {
          yield* ctx.scope.ensure(function* () {
            yield* ctx.await(
              async () => {
                cleaned++;
                return "closed";
              },
              { record: { key: "cleanup" } },
            );
          });
          const number = yield* ctx.await(
            async () => {
              recorded++;
              return 7;
            },
            { record: { key: "number" } },
          );
          const contents = yield* ctx.capabilities.lookup(input.query);
          if (!contents.ok) {
            throw new Error("Read failed");
          }
          const approved = yield* ctx.elicit("lookup", contents.value);
          if (!approved.ok) {
            throw new Error("Approval failed");
          }
          expectTypeOf(approved.value).toEqualTypeOf<boolean>();
          return { number, contents: contents.value, approved: approved.value };
        });
      type Result = { number: number; contents: string; approved: boolean };
      const store = createSqliteJournalRig<Result, CapabilityRequest, unknown, string, unknown, Y>({
        program: tool.id,
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      await start(() => admitTool(runtime, tool, journal, "AUTH"));
      expect(validations).toBe(1);
      const effects = createEffectCapabilities(runtime, "acquisition-root-effects");
      const acquisition = createToolAcquisition(runtime, effects, tool, "root-acquisition");
      function assemble() {
        const recovery = createRecovery<Result, CapabilityRequest, Y, unknown, string>(
          runtime.composition,
          {
            name: "root-recovery",
            program: tool.id,
            matches: isDeepStrictEqual,
            *acquire() {
              const snapshot = yield* journal.read();
              if (!snapshot.admission) {
                throw new Error("Input not admitted");
              }
              return yield* acquisition.operations.acquire(
                snapshot.admission.input as { query: string },
              );
            },
          },
        );
        const host = createHosting(runtime.composition, {
          name: "root-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: acquisition.handle,
        });
        return { host, recovery };
      }
      function run() {
        return start(function* () {
          yield* effects.install(read, function* (query) {
            reads++;
            return { ok: true, value: `file:${query}` };
          });
          yield* acquisition.around({
            *acquire([input], next) {
              expectTypeOf(input).toEqualTypeOf<{ query: string }>();
              expect(input).toEqual({ query: "auth" });
              acquired++;
              yield* runtime.composition.ensure(function* () {
                disposed++;
              });
              return yield* next(input);
            },
          });
          const { host, recovery } = assemble();
          yield* host.around(acquisition.admission);
          yield* host.around({
            *deliveryMode([request], next) {
              return request.effect === approve.id ? "wait" : yield* next(request);
            },
          });
          yield* installGuestRetention(runtime.composition, host, recovery, journal);
          return yield* host.operations.run();
        });
      }
      const waiting = await run();
      if (waiting.state !== "waiting") {
        throw new Error("Expected approval wait");
      }
      expect({ acquired, disposed, recorded, reads, cleaned }).toEqual({
        acquired: 1,
        disposed: 1,
        recorded: 1,
        reads: 1,
        cleaned: 0,
      });
      // A disposed incarnation's delivery grant must not escape its owning scope.
      await expect(start(() => acquisition.handle(waiting.pending.request))).rejects.toThrow(
        "root-acquisition:grant",
      );
      journal = store.reopen();
      if (cancel) {
        await start(() => journal.cancellation.request(waiting.pending.id, "stop tool"));
      } else {
        await start(function* () {
          // Participant ingress does not acquire a Guest or run its input schema.
          const { host } = assemble();
          const ingress = yield* installEffectAnswers(
            host,
            effects.grant(tool.elicits),
            journal.interactions,
          );
          yield* ingress.answer(waiting.grant, { ok: true, value: "yes" });
        });
      }
      const expected = cancel
        ? { state: "cancelled", reason: "stop tool" }
        : { state: "completed", value: { number: 7, contents: "file:auth", approved: true } };
      await expect(run()).resolves.toMatchObject(expected);
      expect({ validations, recorded, reads, cleaned, acquired, disposed }).toEqual({
        validations: 1,
        recorded: 1,
        reads: 1,
        cleaned: 1,
        acquired: 2,
        disposed: 2,
      });
      journal = store.reopen();
      await expect(run()).resolves.toMatchObject(expected);
      expect(acquired).toBe(2);
    });
  }
});
