/**
 * TicTacToe Tool (MCP Standard Sampling)
 *
 * Canonical-core implementation of the original standard MCP sampling demo.
 * A single tool call plays the whole game. Model moves use plain ctx.sample(),
 * then the tool parses the free-form response and falls back to a random legal
 * move only when the sampled text is unusable.
 */
import { defineJournalTool } from "@sweatpants/agent-sdk/primitive";
import { z } from "zod";
import {
  type Board,
  type Player,
  EMPTY_BOARD,
  checkWinner,
  applyMove,
  formatBoard,
} from "../tictactoe/types.ts";

// =============================================================================
// SCHEMAS
// =============================================================================

const CellSchema = z.union([z.literal("X"), z.literal("O"), z.null()]);
const BoardSchema = z
  .tuple([
    CellSchema,
    CellSchema,
    CellSchema,
    CellSchema,
    CellSchema,
    CellSchema,
    CellSchema,
    CellSchema,
    CellSchema,
  ])
  .describe("Board state: 9 cells");

const LastMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(["X", "O"]),
});

const GameMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(["X", "O"]),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z.number(),
});

type GameMove = z.infer<typeof GameMoveSchema>;

type GameClientResult =
  | {
      cancelled: true;
      board: Board;
      boardDisplay: string;
    }
  | {
      status: "x_wins" | "o_wins" | "draw";
      winner: Player | null;
      modelWon: boolean;
      board: Board;
      boardDisplay: string;
      winningLine?: number[];
    };

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const tictactoeTool = defineJournalTool({
  sampling: true,
  name: "tictactoe",
  description: `Play a complete game of tic-tac-toe against the user.

This tool handles the entire game - just call it once and it will:
1. Randomly assign X or O to you and the user
2. Take turns until someone wins or draws
3. Return the final result

You'll pick moves by responding with a cell number. The user will pick their moves interactively.

Board positions:
0 | 1 | 2
---------
3 | 4 | 5
---------
6 | 7 | 8`,
  parameters: z.object({}),
  elicits: {
    pickMove: {
      response: z.object({
        // -1 is used by the game-over UI acknowledgement.
        position: z.number().min(-1).max(8).describe("Cell position user clicked"),
      }),
      context: z.object({
        board: BoardSchema,
        moveHistory: z.array(GameMoveSchema).describe("History of all moves"),
        lastMove: LastMoveSchema.optional(),
        winningLine: z.array(z.number()).optional(),
        gameOver: z.boolean().optional(),
        resultMessage: z.string().optional(),
        modelSymbol: z.enum(["X", "O"]),
        userSymbol: z.enum(["X", "O"]),
      }),
    },
  },
  effects: {
    random: {
      version: "1",
      input: z.object({}),
      output: z.number(),
      retrySafety: { mode: "repeatable" },
    },
  },
  execute: function* (_params, ctx) {
    const modelPlaysX = (yield* ctx.effect("random", {})) < 0.5;
    const modelSymbol = (modelPlaysX ? "X" : "O") as Player;
    const userSymbol = (modelPlaysX ? "O" : "X") as Player;
    const modelGoesFirst = modelPlaysX;

    let board: Board = [...EMPTY_BOARD];
    let currentPlayer: Player = "X";
    const moveHistory: GameMove[] = [];

    yield* ctx.notify(`Game started! Model plays ${modelSymbol}, User plays ${userSymbol}`);

    let clientResult: GameClientResult;

    while (true) {
      const isModelTurn = currentPlayer === modelSymbol;

      if (isModelTurn) {
        // =================================================================
        // MODEL'S TURN: Plain MCP Sampling (no structured output)
        // =================================================================
        yield* ctx.notify("Model is thinking...", 0.5);

        const boardStr = formatBoard(board);
        const emptyPositions = board
          .map((cell, i) => (cell === null ? i : null))
          .filter((i): i is number => i !== null);

        const prompt = `You are playing tic-tac-toe as ${modelSymbol}.

Current board:
${boardStr}

Empty positions: ${emptyPositions.join(", ")}

Reply with ONLY a single digit (0-8) for your move. Nothing else.`;

        const response = yield* ctx.sample({
          prompt,
        });

        const text = response.text ?? "";
        yield* ctx.notify(`Model response: "${text}"`);

        const match = text.match(/\b([0-8])\b/);
        let playedCell: number;

        if (match) {
          const parsed = parseInt(match[1]!, 10);
          if (emptyPositions.includes(parsed)) {
            playedCell = parsed;
            yield* ctx.notify(`Parsed valid move: ${playedCell}`);
          } else {
            yield* ctx.notify(`Model chose occupied cell ${parsed}, falling back to random`);
            playedCell =
              emptyPositions[
                Math.floor((yield* ctx.effect("random", {})) * emptyPositions.length)
              ]!;
          }
        } else {
          yield* ctx.notify(`Could not parse move from "${text}", falling back to random`);
          playedCell =
            emptyPositions[Math.floor((yield* ctx.effect("random", {})) * emptyPositions.length)]!;
        }

        board = applyMove(board, playedCell, modelSymbol);
        yield* ctx.notify(`Model plays cell ${playedCell}`);

        moveHistory.push({
          position: playedCell,
          player: modelSymbol,
          isModel: true,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1,
        });
      } else {
        // =================================================================
        // USER'S TURN: Elicitation with exchange accumulation
        // =================================================================
        const lastEntry = moveHistory[moveHistory.length - 1];
        const lastMove = lastEntry
          ? { position: lastEntry.position, player: lastEntry.player }
          : undefined;

        const result = yield* ctx.elicit("pickMove", {
          message:
            modelGoesFirst && board.filter((cell) => cell !== null).length === 1
              ? `I'm ${modelSymbol}! I made the first move. Your turn as ${userSymbol}!`
              : `Your turn! You're playing as ${userSymbol}.`,
          context: {
            board,
            moveHistory,
            /* CONDITIONAL-SPREAD: Omit absent lastMove from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
            ...(lastMove ? { lastMove } : {}),
            modelSymbol,
            userSymbol,
          },
        });

        if (result.action === "decline" || result.action === "cancel") {
          clientResult = {
            cancelled: true,
            board,
            boardDisplay: formatBoard(board),
          };
          break;
        }

        const userPosition = result.content.position;
        board = applyMove(board, userPosition, userSymbol);
        yield* ctx.notify(`User plays cell ${userPosition}`);

        moveHistory.push({
          position: userPosition,
          player: userSymbol,
          isModel: false,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1,
        });
      }

      const { status, winningLine } = checkWinner(board);
      if (status !== "ongoing") {
        const resultMessage =
          status === "draw"
            ? "It's a draw! Good game!"
            : status === "x_wins"
              ? modelSymbol === "X"
                ? "I win! Good game!"
                : "You win! Well played!"
              : modelSymbol === "O"
                ? "I win! Good game!"
                : "You win! Well played!";

        const lastEntry = moveHistory[moveHistory.length - 1];
        const lastMove = lastEntry
          ? { position: lastEntry.position, player: lastEntry.player }
          : undefined;

        yield* ctx.elicit("pickMove", {
          message: resultMessage,
          context: {
            board,
            moveHistory,
            /* CONDITIONAL-SPREAD: Omit absent lastMove from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
            ...(lastMove ? { lastMove } : {}),
            /* CONDITIONAL-SPREAD: Omit absent winningLine from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
            ...(winningLine ? { winningLine } : {}),
            gameOver: true,
            resultMessage,
            modelSymbol,
            userSymbol,
          },
        });

        clientResult = {
          status,
          winner: status === "draw" ? null : status === "x_wins" ? "X" : "O",
          modelWon:
            status !== "draw" &&
            ((status === "x_wins" && modelSymbol === "X") ||
              (status === "o_wins" && modelSymbol === "O")),
          board,
          boardDisplay: formatBoard(board),
          /* CONDITIONAL-SPREAD: Omit absent winningLine from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
          ...(winningLine ? { winningLine } : {}),
        };
        break;
      }

      currentPlayer = currentPlayer === "X" ? "O" : "X";
    }

    if ("cancelled" in clientResult) {
      return {
        success: false,
        cancelled: true,
        message: "Game was cancelled by the user.",
        board: clientResult.board,
        boardDisplay: clientResult.boardDisplay,
      };
    }

    return {
      success: true,
      modelSymbol,
      userSymbol,
      result:
        clientResult.status === "draw"
          ? "draw"
          : clientResult.modelWon
            ? "model_wins"
            : "user_wins",
      winner: clientResult.winner,
      board: clientResult.board,
      boardDisplay: clientResult.boardDisplay,
      /* CONDITIONAL-SPREAD: Omit absent winningLine from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
      ...(clientResult.winningLine ? { winningLine: clientResult.winningLine } : {}),
      message:
        clientResult.status === "draw"
          ? "The game ended in a draw!"
          : clientResult.modelWon
            ? "I won the game!"
            : "The user won the game!",
    };
  },
});

export type TicTacToeResult =
  | {
      success: true;
      modelSymbol: Player;
      userSymbol: Player;
      result: "model_wins" | "user_wins" | "draw";
      winner: Player | null;
      board: Board;
      boardDisplay: string;
      winningLine?: number[];
      message: string;
    }
  | {
      success: false;
      cancelled: true;
      message: string;
      board?: Board;
      boardDisplay?: string;
    };
