import {
  createHostedRecovery as createRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Outcome, Work } from "@standard-durability/core";
import type { Attempts } from "@sweatpan.ts/durable";
import {
  createHosting,
  createEffectCapabilities,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import { defineTool, createToolAcquisition } from "@sweatpan.ts/tools";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  for (const keyed of [false, true]) {
    it(`${runtime.name}: ${keyed ? "explicit" : "positional"} keys retain distinct ordered outcomes across replay`, async () => {
      const store = createSqliteJournalRig<
        number[],
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({
        program: "record-loop",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      const peer = createProtocolRig();
      let calls = 0;
      const delivered: unknown[] = [];
      function assemble(pause: boolean, key: string | undefined = keyed ? "roll-dice" : undefined) {
        const journal = store.open();
        const effects = createEffectCapabilities(runtime, "record-loop");
        const tool = defineTool("record-loop")
          .parameters(z.undefined())
          .execute(function* (_input, ctx) {
            const results: number[] = [];
            for (let i = 0; i < 3; i++) {
              const outcome = yield* ctx.record(
                function* () {
                  return { ok: true as const, value: ++calls };
                },
                { key },
              );
              results.push(outcome.value);
            }
            return results;
          });
        const acquisition = createToolAcquisition(
          runtime,
          effects,
          tool,
          "record-loop-acquisition",
        );
        const recovery = createRecovery(runtime, {
          name: "record-loop",
          program: tool.id,
          matches: isDeepStrictEqual,
          acquire: () => acquisition.operations.acquire(undefined),
        });
        const host = createHosting(runtime.composition, {
          name: "record-loop-host",
          journal,
          recovery: recovery.operations,
          attempts: {
            begin: journal.attempts.begin,
            *settle(...args: Parameters<typeof journal.attempts.settle>) {
              const result = yield* journal.attempts.settle(...args);
              if (pause) {
                yield* runtime.fromPromise((signal) =>
                  peer.send({ id: "accepted", token: "pause" }, signal),
                );
              }
              return result;
            },
          },
          *handle(request) {
            delivered.push(request.input);
            return yield* acquisition.handle(request);
          },
        });
        return start(function* () {
          yield* host.around(acquisition.admission);
          yield* installGuestRetention(runtime.composition, host, recovery, journal);
          return yield* host.operations.run();
        });
      }
      await expect(assemble(false, "  ").result).rejects.toThrow("Record key must be non-empty");
      expect(calls).toBe(0);
      expect(delivered).toEqual([]);
      const first = assemble(true);
      await Promise.race([peer.waitForRequests(1), first.result]);
      await first.cancel();
      store.reopen();
      await expect(assemble(false).result).resolves.toEqual({
        state: "completed",
        value: [1, 2, 3],
      });
      expect(calls).toBe(3);
      expect(delivered).toEqual(
        [0, 1, 2].map((sequence) => ({ key: keyed ? "roll-dice" : "$position", sequence })),
      );
    });
  }

  // Both interruptions happen after the callback ran. Only one has an accepted value.
  for (const failed of [false, true]) {
    for (const accepted of [true, false]) {
      it(`${runtime.name}: recorded ${failed ? "failure" : "success"} ${accepted ? "replays accepted values" : "keeps an unaccepted attempt occupied"} after reopen`, async () => {
        const store = createSqliteJournalRig<
          { roll: Outcome<number, { code: string }>; card: { suit: string; rank: number } },
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          program: "recorded-draw",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        const peer = createProtocolRig();
        const events: string[] = [];
        let rollCalls = 0;
        let cardCalls = 0;

        function assemble(pause: boolean, recordKey = "roll-dice") {
          const effects = createEffectCapabilities(runtime, "recording");
          const journal = store.open();
          let granted = false;
          function* rollDice() {
            // A deterministic changing source proves whether the callback was repeated.
            expect(granted).toBe(true);
            events.push("roll");
            rollCalls++;
            return failed
              ? { ok: false as const, error: { code: "empty-deck" } }
              : { ok: true as const, value: rollCalls };
          }
          const tool = defineTool("recorded-draw")
            .parameters(z.undefined())
            .execute(function* (_input, ctx) {
              const roll = yield* ctx.record(rollDice, { key: recordKey });
              if (roll.ok) {
                expectTypeOf(roll.value).toEqualTypeOf<number>();
              } else {
                expectTypeOf(roll.error).toEqualTypeOf<{ code: string }>();
              }
              const card = yield* ctx.record(
                function* () {
                  expect(granted).toBe(true);
                  cardCalls++;
                  return { ok: true as const, value: { suit: "hearts", rank: 7 } };
                },
                { key: "pick-card" },
              );
              expectTypeOf(card.value).toEqualTypeOf<{ suit: string; rank: number }>();
              return { roll, card: card.value };
            });
          const acquisition = createToolAcquisition(runtime, effects, tool, "draw-acquisition");
          const recovery = createRecovery(runtime, {
            name: "record-recovery",
            program: tool.id,
            matches: isDeepStrictEqual,
            acquire: () => acquisition.operations.acquire(undefined),
          });
          const host = createHosting(runtime.composition, {
            name: "record-host",
            journal,
            recovery: recovery.operations,
            attempts: {
              *begin(
                ...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["begin"]>
              ) {
                const result = yield* journal.attempts.begin(...args);
                granted = result.state === "granted";
                if (granted) {
                  events.push("granted");
                }
                return result;
              },
              *settle(
                ...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>
              ) {
                if (pause && !accepted) {
                  yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "pause", token: "before-acceptance" }, signal),
                  );
                }
                const result = yield* journal.attempts.settle(...args);
                events.push("accepted");
                if (pause && accepted) {
                  yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "pause", token: "after-acceptance" }, signal),
                  );
                }
                return result;
              },
            },
            handle: acquisition.handle,
          });
          return start(function* () {
            yield* host.around(acquisition.admission);
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
            return yield* host.operations.run();
          });
        }

        const first = assemble(true);
        await Promise.race([peer.waitForRequests(1), first.result]);
        expect(events).toEqual(accepted ? ["granted", "roll", "accepted"] : ["granted", "roll"]);
        await first.cancel();
        store.reopen();
        if (accepted) {
          await expect(assemble(false, "different-operation").result).rejects.toThrow(
            "Replay request mismatch at 0",
          );
          expect(rollCalls).toBe(1);
          expect(cardCalls).toBe(0);
        }
        const result = await assemble(false).result;
        if (accepted) {
          expect(result).toEqual({
            state: "completed",
            value: {
              roll: failed ? { ok: false, error: { code: "empty-deck" } } : { ok: true, value: 1 },
              card: { suit: "hearts", rank: 7 },
            },
          });
          store.reopen();
          await expect(assemble(false).result).resolves.toEqual(result);
          expect(cardCalls).toBe(1);
        } else {
          expect(result.state).toBe("occupied");
          expect(cardCalls).toBe(0);
        }
        expect(rollCalls).toBe(1);
      });
    }
  }
  it(`${runtime.name}: contextual recorded work and named exchanges share hosted recovery`, async () => {
    const peer = createProtocolRig();
    const acknowledgement = createProtocolRig();
    const store = createSqliteJournalRig<
      { path: string; text: string },
      CapabilityRequest,
      unknown,
      string,
      unknown,
      Y
    >({ program: "choose-file", equals: isDeepStrictEqual });
    onTestFinished(() => store.close());
    let draws = 0;
    let choices = 0;
    let transformations = 0;
    let reads = 0;

    function assemble(delay: boolean) {
      const effects = createEffectCapabilities(runtime, "file-exchanges");
      const choose = defineEffect({
        key: "chooseFile",
        context: z.string().transform((path) => ({ paths: [path] })),
        response: z.string().transform((path) => {
          transformations++;
          return { path };
        }),
      });
      const read = defineEffect(
        { key: "workspace.readFile", context: z.string().transform((path) => ({ path })) },
        function* ({ path }) {
          reads++;
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "read", token: path }, signal),
          );
          return { ok: true, value: { path, text: reply.body } };
        },
      );
      const tool = defineTool("choose-file")
        .parameters(z.undefined())
        .capabilities({ read })
        .elicits({ choose })
        .execute(function* (_input, ctx) {
          const offered = yield* ctx.record(
            function* () {
              draws++;
              return { ok: true as const, value: { path: "src/main.ts" } };
            },
            { key: "recorded-operation" },
          );
          const selected = yield* ctx.elicit("choose", offered.value.path);
          if (!selected.ok) {
            throw new Error("Unexpected choice failure");
          }
          const file = yield* ctx.capabilities.read(selected.value.path);
          if (!file.ok) {
            throw new Error("Unexpected read failure");
          }
          expectTypeOf(file.value).toEqualTypeOf<{ path: string; text: string }>();
          return file.value;
        });
      const acquisition = createToolAcquisition(runtime, effects, tool, "file-acquisition");
      const journal = store.open();
      const recovery = createRecovery(runtime, {
        name: "file-recovery",
        program: tool.id,
        matches: isDeepStrictEqual,
        acquire: () => acquisition.operations.acquire(undefined),
      });
      let settlements = 0;
      const host = createHosting(runtime.composition, {
        name: "file-host",
        journal,
        recovery: recovery.operations,
        attempts: {
          begin: (...args) => journal.attempts.begin(...args),
          *settle(...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>) {
            const result = yield* journal.attempts.settle(...args);
            settlements++;
            if (delay && settlements === 2) {
              yield* runtime.fromPromise((signal) =>
                acknowledgement.send({ id: "accepted-choice", token: "pause" }, signal),
              );
            }
            return result;
          },
        },
        handle: acquisition.handle,
      });
      return start(function* () {
        yield* host.around(acquisition.admission);
        yield* effects.install(read);
        yield* effects.install(choose, function* ({ paths }) {
          choices++;
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "choose", token: paths.join(",") }, signal),
          );
          return { ok: true as const, value: reply.body };
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        return yield* host.operations.run();
      });
    }
    const first = assemble(true);
    await Promise.race([peer.waitForRequests(1), first.result]);
    peer.reply("choose", { status: 200, body: "src/main.ts" });
    await Promise.race([acknowledgement.waitForRequests(1), first.result]);
    await first.cancel();
    store.reopen();
    const second = assemble(false);
    await Promise.race([peer.waitForRequests(2), second.result]);
    expect(peer.requests).toEqual([
      { id: "choose", token: "src/main.ts" },
      { id: "read", token: "src/main.ts" },
    ]);
    peer.reply("read", { status: 200, body: "export const answer = 42;" });
    await expect(second.result).resolves.toEqual({
      state: "completed",
      value: { path: "src/main.ts", text: "export const answer = 42;" },
    });
    expect({ draws, choices, transformations, reads }).toEqual({
      draws: 1,
      choices: 1,
      transformations: 1,
      reads: 1,
    });
  });
});
