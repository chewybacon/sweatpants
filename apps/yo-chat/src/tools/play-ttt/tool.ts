import {
  GameMoveSchema,
  PickMoveResponseSchema,
  ModelCellSchema,
  PlayTttResultSchema,
  PickMoveContextSchema,
} from "../schemas/play-ttt.ts";
/** Journal-native tic-tac-toe program and public tool contract. */
import { createDurableTool } from "@sweatpants/agent-sdk";
import type { ProgramElicitResult } from "@sweatpants/durable-execution";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";
import type { Operation } from "effection";

import {
  type Board,
  type Player,
  EMPTY_BOARD,
  checkWinner,
  applyMove,
  formatBoard,
} from "../tictactoe/types.ts";

type GameMove = z.infer<typeof GameMoveSchema>;

/**
 * The canonical game is a synchronous durable Effection program. Symbol
 * assignment is an execution-owned recorded coin flip, user moves are
 * elicitations, and model moves are completed model.sample pulls.
 */
export const playTttTool = createDurableTool("play_ttt")
  .description(`Play a complete game of tic-tac-toe against the user.

The program flips a recorded coin for symbols, alternates model and user moves, and returns the final board.`)
  .identity({
    version: "3.0.0",
    digest: sha256("yo-chat.play-ttt@3.0.0:recorded-symbol-coin-flip-v1"),
  })
  .parameters(z.object({}))
  .elicits({ pickMove: { response: PickMoveResponseSchema, context: PickMoveContextSchema } })
  .samples()
  .execute(function* (_input, context): Operation<PlayTttResult> {
    const coinFlip = yield* context.record(
      {
        key: "play-ttt-symbol-coin-flip",
        retrySafety: { mode: "repeatable" },
      },
      function* () {
        return { side: Math.random() < 0.5 ? ("heads" as const) : ("tails" as const) };
      },
    );
    const modelSymbol: Player = coinFlip.side === "heads" ? "X" : "O";
    const userSymbol: Player = modelSymbol === "X" ? "O" : "X";
    let board: Board = [...EMPTY_BOARD];
    let currentPlayer: Player = "X";
    const moveHistory: GameMove[] = [];

    while (true) {
      if (currentPlayer === modelSymbol) {
        const emptyPositions = board
          .map((cell, index) => (cell === null ? index : null))
          .filter((index): index is number => index !== null);
        const sampled = yield* context.sampleSchema({
          prompt: [
            `You are ${modelSymbol}. Pick one legal tic-tac-toe move.`,
            formatBoard(board),
            `Empty positions: ${emptyPositions.join(", ")}`,
          ].join("\n"),
          schema: ModelCellSchema,
          retries: 2,
        });
        const requested = sampled.parsed.cell;
        const position = emptyPositions.includes(requested) ? requested : emptyPositions[0]!;
        board = applyMove(board, position, modelSymbol);
        moveHistory.push({
          position,
          player: modelSymbol,
          isModel: true,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1,
          /* CONDITIONAL-SPREAD: Omit absent reasoning from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
          ...(sampled.text ? { reasoning: sampled.text.slice(0, 512) } : {}),
        });
      } else {
        let accepted = false;
        while (!accepted) {
          const last = moveHistory.at(-1);
          const response: ProgramElicitResult<z.infer<typeof PickMoveResponseSchema>> =
            yield* context.elicit("pickMove", {
              message: `Your turn! You're playing as ${userSymbol}.`,
              context: {
                board,
                moveHistory,
                /* CONDITIONAL-SPREAD: Omit absent lastMove from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
                ...(last ? { lastMove: { position: last.position, player: last.player } } : {}),
                modelSymbol,
                userSymbol,
              },
            });
          if (response.action !== "accept") {
            return {
              success: false as const,
              cancelled: true as const,
              message: "Game was cancelled by the user.",
              board,
              boardDisplay: formatBoard(board),
            };
          }
          const position = response.content.position;
          if (position < 0 || board[position] !== null) {
            continue;
          }
          board = applyMove(board, position, userSymbol);
          moveHistory.push({
            position,
            player: userSymbol,
            isModel: false,
            boardAfter: [...board],
            moveNumber: moveHistory.length + 1,
          });
          accepted = true;
        }
      }

      const { status, winningLine } = checkWinner(board);
      if (status !== "ongoing") {
        const winner: Player | null = status === "draw" ? null : status === "x_wins" ? "X" : "O";
        const modelWon = winner === modelSymbol;
        const resultMessage =
          status === "draw"
            ? "It's a draw! Good game!"
            : modelWon
              ? "I win! Good game!"
              : "You win! Well played!";
        const last = moveHistory.at(-1);
        yield* context.elicit("pickMove", {
          message: resultMessage,
          context: {
            board,
            moveHistory,
            /* CONDITIONAL-SPREAD: Omit absent lastMove from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
            ...(last ? { lastMove: { position: last.position, player: last.player } } : {}),
            /* CONDITIONAL-SPREAD: Omit absent winningLine from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
            ...(winningLine ? { winningLine } : {}),
            gameOver: true,
            resultMessage,
            modelSymbol,
            userSymbol,
          },
        });
        return {
          success: true as const,
          modelSymbol,
          userSymbol,
          result:
            status === "draw"
              ? ("draw" as const)
              : modelWon
                ? ("model_wins" as const)
                : ("user_wins" as const),
          winner,
          board,
          boardDisplay: formatBoard(board),
          /* CONDITIONAL-SPREAD: Omit absent winningLine from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
          ...(winningLine ? { winningLine } : {}),
          message:
            status === "draw"
              ? "The game ended in a draw!"
              : modelWon
                ? "I won the game!"
                : "The user won the game!",
        };
      }
      currentPlayer = currentPlayer === "X" ? "O" : "X";
    }
  });

export type PlayTttResult = z.infer<typeof PlayTttResultSchema>;
