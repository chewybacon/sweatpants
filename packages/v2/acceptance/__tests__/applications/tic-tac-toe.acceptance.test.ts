import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
  installEffectAnswers,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig, createSqliteJournalRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

type Player = "X" | "O";
type Cell = Player | null;
const boardSchema: StandardSchemaV1<readonly Cell[], readonly Cell[]> = {
  "~standard": {
    version: 1,
    vendor: "tic-tac-toe",
    validate(value) {
      return Array.isArray(value) &&
        value.length === 9 &&
        value.every((cell) => cell === null || cell === "X" || cell === "O")
        ? { value: value as Cell[] }
        : { issues: [{ message: "Expected nine board cells" }] };
    },
  },
};
const moveSchema: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "tic-tac-toe",
    validate(value) {
      return typeof value === "string" && /^[0-8]$/.test(value)
        ? { value: Number(value) }
        : { issues: [{ message: "Expected a cell from 0 to 8" }] };
    },
  },
};
const chooseModelMove = defineEffect({
  key: "ttt.model-move",
  context: boardSchema,
  response: moveSchema,
});
const pickUserMove = defineEffect({
  key: "ttt.user-move",
  context: boardSchema,
  response: moveSchema,
});

function winner(board: readonly Cell[]): Player | undefined {
  for (const [a, b, c] of [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ]) {
    const player = board[a!];
    if (player && player === board[b!] && player === board[c!]) {
      return player;
    }
  }
  return undefined;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const heads of [true, false]) {
    for (const interruption of ["none", "player-wait", "accepted-model-move"] as const) {
      it(`${runtime.name}: tic-tac-toe ${heads ? "model" : "user"} wins across ${interruption}`, async () => {
        const model = createProtocolRig();
        const acknowledgement = createProtocolRig();
        let coinCalls = 0;
        let modelCalls = 0;
        let answered = 0;
        let acquisitions = 0;
        let disposals = 0;
        let interrupted = false;
        const deliveredBoards: unknown[] = [];
        function acquireContext(effects: ReturnType<typeof createEffectCapabilities<Y>>) {
          return effects.grant({ chooseModelMove, pickUserMove }, { record: true });
        }

        // The authored application uses only record and the granted typed effects.
        function* playTtt(ctx: ReturnType<typeof acquireContext>) {
          const coin = yield* ctx.record(
            function* () {
              coinCalls++;
              return { ok: true as const, value: heads ? ("heads" as const) : ("tails" as const) };
            },
            { key: "play-ttt-symbol-coin-flip" },
          );
          const modelSymbol: Player = coin.value === "heads" ? "X" : "O";
          let board: Cell[] = Array<Cell>(9).fill(null);
          let player: Player = "X";
          const moves: { player: Player; cell: number }[] = [];
          while (true) {
            const modelTurn = player === modelSymbol;
            const move = modelTurn
              ? yield* ctx.capabilities.chooseModelMove(board)
              : yield* ctx.capabilities.pickUserMove(board);
            if (!move.ok) {
              return { status: "failed" as const, modelSymbol, board, moves, error: move.error };
            }
            expectTypeOf(move.value).toEqualTypeOf<number>();
            // A syntactically valid reply can still select an occupied cell.
            // Re-elicit from the same player; never mutate a previously yielded board.
            if (board[move.value] !== null) {
              continue;
            }
            board = board.map((cell, index) => (index === move.value ? player : cell));
            moves.push({ player, cell: move.value });
            const won = winner(board);
            if (won || board.every((cell) => cell !== null)) {
              return {
                status: "completed" as const,
                modelSymbol,
                winner: won ?? ("draw" as const),
                board,
                moves,
              };
            }
            player = player === "X" ? "O" : "X";
          }
        }
        type GameResult =
          ReturnType<typeof playTtt> extends Generator<unknown, infer Result, unknown>
            ? Result
            : never;
        const store = createSqliteJournalRig<
          GameResult,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          program: "play-ttt-v2",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        function start<T>(work: Work<T, Y>) {
          const execution = runtime.start(work);
          void execution.result.catch(() => undefined);
          onTestFinished(() => execution.cancel());
          return execution;
        }
        function assemble() {
          const journal = store.open();
          const effects = createEffectCapabilities(runtime, "game-effects");
          let current: ReturnType<typeof acquireContext> | undefined;
          const recovery = createRecovery(runtime.composition, {
            name: "game-recovery",
            program: "play-ttt-v2",
            matches: isDeepStrictEqual,
            *acquire() {
              acquisitions++;
              const ctx = acquireContext(effects);
              current = ctx;
              yield* ctx.install();
              const guest = createScopedGuest(() => playTtt(ctx));
              return {
                ...guest,
                *close() {
                  disposals++;
                  yield* guest.close();
                },
              };
            },
          });
          const host = createHosting(runtime.composition, {
            name: "game-host",
            journal,
            recovery: recovery.operations,
            interactions: journal.interactions,
            attempts: {
              begin: journal.attempts.begin,
              *settle(...args: Parameters<typeof journal.attempts.settle>) {
                const result = yield* journal.attempts.settle(...args);
                if (interruption === "accepted-model-move" && modelCalls === 1 && !interrupted) {
                  interrupted = true;
                  yield* runtime.fromPromise((signal) =>
                    acknowledgement.send({ id: "accepted", token: "pause" }, signal),
                  );
                }
                return result;
              },
            },
            *handle(request) {
              return yield* current!.handle(request);
            },
          });
          return {
            run() {
              return start(function* () {
                yield* effects.install(chooseModelMove, function* (board) {
                  const id = `model-${++modelCalls}`;
                  deliveredBoards.push([...board]);
                  const reply = yield* runtime.fromPromise((signal) =>
                    model.send({ id, token: JSON.stringify(board) }, signal),
                  );
                  return { ok: true as const, value: reply.body };
                });
                yield* host.around({
                  *child(args, next) {
                    return yield* current!.admission.child(args, next);
                  },
                  *deliveryMode([request], next) {
                    return request.effect === pickUserMove.id ? "wait" : yield* next(request);
                  },
                });
                yield* installGuestRetention(runtime.composition, host, recovery, journal);
                return yield* host.operations.run();
              });
            },
            answer(
              wait: { grant: ResolutionGrant; pending: { request: CapabilityRequest } },
              raw: string,
            ) {
              return start(function* () {
                const answers = yield* installEffectAnswers(
                  host,
                  effects.grant({ pickUserMove }),
                  journal.interactions,
                );
                const acceptance = yield* answers.answer(wait.grant, {
                  ok: true,
                  value: raw,
                });
                answered++;
                return acceptance;
              }).result;
            },
          };
        }

        let app = assemble();
        let run = app.run();
        let modelReplies = 0;
        let userMoves = 0;
        let reopenedWait = false;
        let invalidReplyTried = false;
        let occupiedReplyTried = false;
        while (true) {
          const event = await Promise.race([
            run.result.then((result) => ({ kind: "result" as const, result })),
            model.waitForRequests(modelReplies + 1).then(() => ({ kind: "model" as const })),
          ]);
          if (event.kind === "model") {
            const cell = heads ? [0, 1, 2][modelReplies]! : [3, 4][modelReplies]!;
            model.reply(`model-${++modelReplies}`, { status: 200, body: String(cell) });
            if (interruption === "accepted-model-move" && modelReplies === 1) {
              await Promise.race([acknowledgement.waitForRequests(1), run.result]);
              await run.cancel();
              store.reopen();
              app = assemble();
              run = app.run();
            }
            continue;
          }
          const result = event.result;
          if (result.state === "completed") {
            expect(result.value).toEqual({
              status: "completed",
              modelSymbol: heads ? "X" : "O",
              winner: "X",
              board: ["X", "X", "X", "O", "O", null, null, null, null],
              moves: [
                { player: "X", cell: 0 },
                { player: "O", cell: 3 },
                { player: "X", cell: 1 },
                { player: "O", cell: 4 },
                { player: "X", cell: 2 },
              ],
            });
            break;
          }
          if (result.state !== "waiting") {
            throw new Error(`Unexpected game state: ${result.state}`);
          }
          if (interruption === "player-wait" && !reopenedWait) {
            reopenedWait = true;
            store.reopen();
            app = assemble();
            run = app.run();
            const again = await run.result;
            expect(again).toEqual(result);
          }
          if (!invalidReplyTried) {
            invalidReplyTried = true;
            await expect(app.answer(result, "9")).rejects.toThrow("Effect schema rejected value");
          }
          if (userMoves === 1 && !occupiedReplyTried) {
            occupiedReplyTried = true;
            await app.answer(result, "0");
          } else {
            const cell = heads ? [3, 4][userMoves]! : [0, 1, 2][userMoves]!;
            await app.answer(result, String(cell));
            userMoves++;
          }
          run = app.run();
        }
        expect(coinCalls).toBe(1);
        expect(modelCalls).toBe(heads ? 3 : 2);
        expect(answered).toBe((heads ? 2 : 3) + 1);
        expect(acquisitions).toBe(disposals);
        expect(deliveredBoards[0]).toEqual(
          heads ? Array(9).fill(null) : ["X", null, null, null, null, null, null, null, null],
        );
        store.reopen();
        await expect(assemble().run().result).resolves.toMatchObject({ state: "completed" });
        expect(coinCalls).toBe(1);
        expect(modelCalls).toBe(modelReplies);
      });
    }
  }
});
