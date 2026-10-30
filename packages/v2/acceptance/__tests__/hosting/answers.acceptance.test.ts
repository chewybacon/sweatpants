import {
  createHostedRecovery as createRecovery,
  createLatch,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  type Hosting,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of [
    "strict",
    "transform",
    "revoked-during-validation",
    "authored-failure",
  ] as const) {
    it(`${runtime.name}: ${mode} answers bind schemas to durable resolution grants`, async () => {
      let parsed = 0;
      let contexts = 0;
      let block = false;
      const validating = createLatch<void>();
      const proceed = createLatch<void>();
      const context: StandardSchemaV1<string, string> = {
        "~standard": {
          version: 1,
          vendor: "answers",
          validate(value) {
            contexts++;
            return typeof value === "string"
              ? { value }
              : { issues: [{ message: "Expected prompt" }] };
          },
        },
      };
      const response: StandardSchemaV1<unknown, number> = {
        "~standard": {
          version: 1,
          vendor: "answers",
          async validate(value) {
            parsed++;
            if (block) {
              validating.resolve();
              await proceed.promise;
            }
            const number =
              mode === "strict"
                ? value
                : typeof value === "string" && /^\d+$/.test(value)
                  ? Number(value)
                  : undefined;
            return typeof number === "number" &&
              Number.isInteger(number) &&
              number >= 0 &&
              number <= 8
              ? { value: number }
              : { issues: [{ message: "Invalid cell" }] };
          },
        },
      };
      const pick = defineEffect({ key: "pick-cell", context, response });
      const unrelated = defineEffect({ key: "other-cell", context, response });
      const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>(
        {
          program: "participant-answer",
          equals: isDeepStrictEqual,
        },
      );
      onTestFinished(() => {
        proceed.resolve();
        store.close();
      });
      function start<T>(work: Work<T, Y>) {
        const execution = runtime.start(work);
        void execution.result.catch(() => undefined);
        onTestFinished(() => execution.cancel());
        return execution;
      }
      function assemble() {
        const journal = store.open();
        const effects = createEffectCapabilities(runtime, "answers");
        const granted = effects.grant({ pick });
        const recovery = createRecovery<unknown, CapabilityRequest, Y, unknown, string>(runtime, {
          name: "answers-recovery",
          program: "participant-answer",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* () {
              const result = yield* granted.capabilities.pick("Which cell?");
              if (result.ok) {
                expectTypeOf(result.value).toEqualTypeOf<number>();
              }
              return result;
            });
          },
        });
        const host: Hosting<unknown, CapabilityRequest, unknown, string, Y> = createHosting(
          runtime.composition,
          {
            name: "answers-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            interactions: journal.interactions,
            handle: granted.handle,
          },
        );
        return {
          run() {
            return start(function* () {
              yield* host.around(granted.admission);
              yield* host.around({
                *deliveryMode() {
                  return "wait";
                },
              });
              return yield* host.operations.run();
            }).result;
          },
          answer(grant: ResolutionGrant, value: unknown, wrongDefinition = false) {
            return start(function* () {
              const answers = yield* installEffectAnswers(
                host,
                wrongDefinition ? effects.grant({ unrelated }) : granted,
                journal.interactions,
              );
              return yield* answers.answer(
                grant,
                mode === "authored-failure"
                  ? { ok: false, error: { code: value } }
                  : { ok: true, value },
              );
            }).result;
          },
        };
      }
      let app = assemble();
      const waiting = await app.run();
      if (waiting.state !== "waiting") {
        throw new Error("Expected participant wait");
      }
      if (mode === "authored-failure") {
        const accepted = await app.answer(waiting.grant, "declined");
        expectTypeOf(accepted.entry.outcome).toEqualTypeOf<
          import("@standard-durability/core").Outcome<unknown, string>
        >();
        expect(accepted.duplicate).toBe(false);
        expect(accepted.entry.outcome).toEqual({
          ok: true,
          value: { ok: false, error: { code: "declined" } },
        });
        store.reopen();
        app = assemble();
        expect((await app.answer(waiting.grant, "declined")).duplicate).toBe(true);
        await expect(app.answer(waiting.grant, "different")).rejects.toThrow();
        await expect(app.run()).resolves.toEqual({
          state: "completed",
          value: { ok: false, error: { code: "declined" } },
        });
        expect((await app.answer(waiting.grant, "declined")).duplicate).toBe(true);
        expect(parsed).toBe(0);
        expect(contexts).toBe(0);
        return;
      }
      const good = mode === "strict" ? 3 : "3";
      await expect(app.answer(waiting.grant, mode === "strict" ? "3" : 3)).rejects.toThrow(
        "Effect schema rejected value",
      );
      expect((await start(() => store.open().read()).result).frontier.position).toBe(0);
      expect(parsed).toBe(1);
      await expect(app.answer({ ...waiting.grant, resolutionId: "forged" }, good)).rejects.toThrow(
        "Unknown resolution authority",
      );
      await expect(app.answer(waiting.grant, good, true)).rejects.toThrow("Effect is not granted");
      expect(parsed).toBe(1);
      if (mode === "revoked-during-validation") {
        block = true;
        const answer = app.answer(waiting.grant, good);
        // Attach immediately: rejection may race the assertion after releasing validation.
        const rejected = expect(answer).rejects.toThrow("Resolution authority revoked");
        await validating.promise;
        await start(() => store.open().interactions.invalidate(waiting.grant, "deadline")).result;
        proceed.resolve();
        await rejected;
        expect((await start(() => store.open().read()).result).frontier.position).toBe(0);
        return;
      }
      const accepted = await app.answer(waiting.grant, good);
      expect(accepted.duplicate).toBe(false);
      expect(accepted.entry.outcome).toEqual({ ok: true, value: { ok: true, value: 3 } });
      store.reopen();
      app = assemble();
      expect((await app.answer(waiting.grant, mode === "strict" ? 3 : "03")).duplicate).toBe(true);
      await expect(app.answer(waiting.grant, mode === "strict" ? 4 : "4")).rejects.toThrow();
      expect(parsed).toBe(4);
      await expect(app.run()).resolves.toEqual({
        state: "completed",
        value: { ok: true, value: 3 },
      });
      expect(parsed).toBe(4);
      expect(contexts).toBe(0);
      // Duplicate answer resolution still selects its original request after completion.
      expect((await app.answer(waiting.grant, good)).duplicate).toBe(true);
    });
  }
});
