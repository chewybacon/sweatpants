/** Journal-native tic-tac-toe program and public tool contract. */
import { createDurableTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";

import {
  type Board,
  type Player,
  EMPTY_BOARD,
  checkWinner,
  applyMove,
  formatBoard,
} from "../tictactoe/types.ts";

const CellSchema = z.union([z.literal("X"), z.literal("O"), z.null()]);
const BoardSchema = z.array(CellSchema).length(9);
const LastMoveSchema = z.object({
  position: z.number().int().min(0).max(8),
  player: z.enum(["X", "O"]),
});
const GameMoveSchema = z.object({
  position: z.number().int().min(0).max(8),
  player: z.enum(["X", "O"]),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z.number().int().positive(),
  reasoning: z.string().optional(),
});
const PickMoveResponseSchema = z.object({
  // -1 acknowledges the terminal board.
  position: z.number().int().min(-1).max(8),
});
const ModelCellSchema = z.object({ cell: z.number().int().min(0).max(8) });
const PickMoveContextSchema = z.object({
  board: BoardSchema,
  moveHistory: z.array(GameMoveSchema),
  lastMove: LastMoveSchema.optional(),
  winningLine: z.array(z.number().int()).optional(),
  gameOver: z.boolean().optional(),
  resultMessage: z.string().optional(),
  modelSymbol: z.enum(["X", "O"]),
  userSymbol: z.enum(["X", "O"]),
});
const PlayTttResultSchema = z.union([
  z.object({
    success: z.literal(true),
    modelSymbol: z.enum(["X", "O"]),
    userSymbol: z.enum(["X", "O"]),
    result: z.enum(["model_wins", "user_wins", "draw"]),
    winner: z.enum(["X", "O"]).nullable(),
    board: BoardSchema,
    boardDisplay: z.string(),
    winningLine: z.array(z.number().int()).optional(),
    message: z.string(),
  }),
  z.object({
    success: z.literal(false),
    cancelled: z.literal(true),
    message: z.string(),
    board: BoardSchema.optional(),
    boardDisplay: z.string().optional(),
  }),
]);

type GameMove = z.infer<typeof GameMoveSchema>;

/**
 * The canonical game is a synchronous durable Effection program. Symbol
 * assignment is an execution-owned recorded coin flip, user moves are
 * elicitations, and model moves are completed model.sample effects.
 */
export const playTttTool = createDurableTool("play_ttt")
  .description(`Play a complete game of tic-tac-toe against the user.

The program flips a recorded coin for symbols, alternates model and user moves, and returns the final board.`)
  .identity({
    version: "3.0.0",
    digest: sha256("yo-chat.play-ttt@3.0.0:recorded-symbol-coin-flip-v1"),
  })
  .parameters(z.object({}))
  .elicits({
    pickMove: {
      response: PickMoveResponseSchema,
      context: PickMoveContextSchema,
    },
  })
  .samples()
  .execute(function* (_input, context) {
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
          ...(sampled.text ? { reasoning: sampled.text.slice(0, 512) } : {}),
        });
      } else {
        let accepted = false;
        while (!accepted) {
          const last = moveHistory.at(-1);
          const response = yield* context.elicit("pickMove", {
            message: `Your turn! You're playing as ${userSymbol}.`,
            context: {
              board,
              moveHistory,
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
            ...(last ? { lastMove: { position: last.position, player: last.player } } : {}),
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
