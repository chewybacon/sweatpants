import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "effection";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { tictactoeTool } from "../tool.ts";
import type { Board } from "../types.ts";

afterEach(() => vi.restoreAllMocks());

describe("tic-tac-toe terminal results", () => {
  it.each([
    { modelPlaysX: false, draw: true },
    { modelPlaysX: true, draw: true },
    { modelPlaysX: false, draw: false },
    { modelPlaysX: true, draw: false },
  ])(
    "records a canonical result (model plays X: $modelPlaysX, draw: $draw)",
    async ({ modelPlaysX, draw }) => {
      vi.spyOn(Math, "random").mockReturnValue(modelPlaysX ? 0.1 : 0.9);
      const xMoves = draw ? [4, 8, 1, 3, 6] : [0, 1, 2];
      const oMoves = draw ? [0, 2, 7, 5] : [3, 4];
      const modelMoves = [...(modelPlaysX ? xMoves : oMoves)];
      const userMoves = [...(modelPlaysX ? oMoves : xMoves)];
      let acknowledgedGameOver = false;
      type Context = Parameters<typeof tictactoeTool>[0];
      const context: Context = {
        signal: new AbortController().signal,
        messages: [],
        *log() {},
        *notify() {},
        // This tool uses only plain-text sampling; other sampling modes are not invoked.
        sample: function* () {
          return { text: String(modelMoves.shift()) };
        } as Context["sample"],
        *sampleTools() {
          throw new Error("unexpected structured sampling");
        },
        *sampleSchema() {
          throw new Error("unexpected schema sampling");
        },
        elicit: function* (_key: string, input: unknown) {
          const request = input as { context: { gameOver?: boolean; board: Board } };
          if (request.context.gameOver) {
            acknowledgedGameOver = true;
            expect(request.context.board).toEqual(
              draw
                ? ["O", "X", "O", "X", "X", "O", "X", "O", "X"]
                : ["X", "X", "X", "O", "O", null, null, null, null],
            );
          }
          return {
            action: "accept",
            content: { position: request.context.gameOver ? -1 : userMoves.shift()! },
          };
        } as Context["elicit"],
      };
      const result = await run(function* () {
        const play = yield* tictactoeTool(context);
        return yield* play({});
      });
      expect(acknowledgedGameOver).toBe(true);
      expect(modelMoves).toEqual([]);
      expect(userMoves).toEqual([]);
      expect(result).toMatchObject({
        success: true,
        result: draw ? "draw" : modelPlaysX ? "model_wins" : "user_wins",
        winner: draw ? null : "X",
      });
      // Canonical recording rejects present undefined fields; JSON.stringify would hide the bug.
      expect(() => canonicalSnapshot(result)).not.toThrow();
      if (draw) {
        expect(result).not.toHaveProperty("winningLine");
      } else {
        expect(result).toHaveProperty("winningLine", [0, 1, 2]);
      }
    },
  );
});
