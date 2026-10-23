import { CrankError, type ProgramElicitResult } from "@sweatpants/durable-execution";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { canonicalJson, sha256 } from "@sweatpants/foundation";
import type { WorkspaceFilesApi } from "@sweatpants/workspace-runtime/api";
import type { Operation } from "effection";
import { z } from "zod";

import { workspace } from "./workspace.ts";

const PlayerSchema = z.enum(["X", "O"]);
const CellSchema = z.union([PlayerSchema, z.null()]);
const BoardSchema = z.array(CellSchema).length(9);
const ResultSchema = z.enum(["model_wins", "user_wins", "draw"]);
const GameIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const WorkspaceRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ModelMoveSchema = z.object({ position: z.number().int().min(0).max(8) });
const MoveSchema = z.object({
  moveNumber: z.number().int().positive(),
  player: PlayerSchema,
  position: z.number().int().min(0).max(8),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  reasoning: z.string().max(512).optional(),
});
const LastMoveSchema = z.object({
  position: z.number().int().min(0).max(8),
  player: PlayerSchema,
});
const PickMoveResponseSchema = z.object({ position: z.number().int().min(-1).max(8) });
const PickMoveContextSchema = z.object({
  board: BoardSchema,
  moveHistory: z.array(MoveSchema).max(9),
  lastMove: LastMoveSchema.optional(),
  winningLine: z.array(z.number().int().min(0).max(8)).max(3).optional(),
  gameOver: z.boolean().optional(),
  resultMessage: z.string().max(256).optional(),
  modelSymbol: PlayerSchema,
  userSymbol: PlayerSchema,
});
const GameFileSchema = z.object({
  format: z.literal("yo-studio.tic-tac-toe-game.v2"),
  gameId: GameIdSchema,
  modelSymbol: PlayerSchema,
  userSymbol: PlayerSchema,
  result: ResultSchema,
  winner: PlayerSchema.nullable(),
  winningLine: z.array(z.number().int().min(0).max(8)).max(3),
  board: BoardSchema,
  boardDisplay: z.string(),
  moves: z.array(MoveSchema).min(5).max(9),
});
const RecordEntrySchema = z.object({
  gameId: GameIdSchema,
  result: ResultSchema,
  gamePath: z.string(),
});
const WinLossRecordSchema = z.object({
  format: z.literal("yo-studio.tic-tac-toe-record.v1"),
  gamesPlayed: z.number().int().nonnegative(),
  modelWins: z.number().int().nonnegative(),
  userWins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  games: z.array(RecordEntrySchema).max(1_000),
});
const PlayTttOutputSchema = z.object({
  gameId: GameIdSchema,
  modelSymbol: PlayerSchema,
  userSymbol: PlayerSchema,
  result: ResultSchema,
  winner: PlayerSchema.nullable(),
  winningLine: z.array(z.number().int().min(0).max(8)).max(3),
  board: BoardSchema,
  boardDisplay: z.string(),
  gamePath: z.string(),
  recordPath: z.string(),
  workspaceRevision: WorkspaceRevisionSchema,
});

export type Player = z.infer<typeof PlayerSchema>;
export type Board = Array<Player | null>;
export type GameResult = z.infer<typeof ResultSchema>;
export type GameMove = z.infer<typeof MoveSchema>;
type WinLossRecord = z.infer<typeof WinLossRecordSchema>;

const EMPTY_BOARD: Board = [null, null, null, null, null, null, null, null, null];
const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;
const RECORD_PATH = "tic-tac-toe-record.json";

/**
 * Plays a complete interactive durable game, eliciting every user move before
 * recording the final game and cumulative record in WorkspaceFiles.
 */
export const playTttTool = createDurableTool("play_ttt")
  .description(
    "Play an interactive tic-tac-toe game, eliciting every user move and persisting the game and cumulative win-loss record",
  )
  .identity({
    version: "2.0.0",
    digest: sha256("yo-studio.play-ttt@2.0.0:interactive-elicit-and-workspace-record-v1"),
  })
  .parameters(z.object({ gameId: GameIdSchema.optional() }))
  .output(PlayTttOutputSchema)
  .elicits({
    pickMove: {
      response: PickMoveResponseSchema,
      context: PickMoveContextSchema,
    },
  })
  .samples()
  .uses({ workspace })
  .execute(function* ({ gameId: requestedGameId }, context) {
    const assignment = yield* context.record(
      {
        key: "yo-studio-play-ttt-symbol-coin-flip",
        retrySafety: { mode: "repeatable" },
      },
      function* () {
        return {
          side: Math.random() < 0.5 ? ("heads" as const) : ("tails" as const),
          gameId: requestedGameId ?? randomGameId(),
        };
      },
    );
    const gameId = assignment.gameId;
    const modelSymbol: Player = assignment.side === "heads" ? "X" : "O";
    const userSymbol: Player = modelSymbol === "X" ? "O" : "X";
    let currentPlayer: Player = "X";
    let board: Board = [...EMPTY_BOARD];
    const moves: GameMove[] = [];
    let result: GameResult;
    let winner: Player | null;
    let winningLine: number[] = [];

    while (true) {
      const empty = board.flatMap((cell, position) => (cell === null ? [position] : []));
      let position: number;
      let reasoning: string | undefined;
      if (currentPlayer === modelSymbol) {
        const sampled = yield* context.sampleSchema({
          prompt: [
            `You are ${modelSymbol} in tic-tac-toe. Pick one legal cell to win or block the user.`,
            formatBoard(board),
            `Legal cells: ${empty.join(", ")}`,
          ].join("\n"),
          schema: ModelMoveSchema,
          retries: 2,
        });
        position = empty.includes(sampled.parsed.position) ? sampled.parsed.position : empty[0]!;
        reasoning = sampled.text.trim().slice(0, 512) || undefined;
      } else {
        while (true) {
          const lastMove = moves.at(-1);
          const response: ProgramElicitResult<z.infer<typeof PickMoveResponseSchema>> =
            yield* context.elicit("pickMove", {
              message: `Your turn — you are ${userSymbol}. Pick an empty cell.`,
              context: {
                board,
                moveHistory: moves,
                /* CONDITIONAL-SPREAD: Omit absent lastMove from authored tool results; explicit undefined is not a portable JSON value. */
                ...(lastMove
                  ? { lastMove: { position: lastMove.position, player: lastMove.player } }
                  : {}),
                modelSymbol,
                userSymbol,
              },
            });
          if (response.action !== "accept") {
            throw new CrankError("program_cancelled", "Tic-tac-toe game was cancelled");
          }
          const selected = response.content.position;
          if (selected >= 0 && board[selected] === null) {
            position = selected;
            break;
          }
        }
      }

      board = board.map((cell, index) => (index === position ? currentPlayer : cell));
      moves.push({
        moveNumber: moves.length + 1,
        player: currentPlayer,
        position,
        isModel: currentPlayer === modelSymbol,
        boardAfter: [...board],
        /* CONDITIONAL-SPREAD: Omit absent reasoning from authored tool results; explicit undefined is not a portable JSON value. */
        ...(reasoning ? { reasoning } : {}),
      });

      const terminal = gameStatus(board);
      if (terminal.winner || terminal.draw) {
        winner = terminal.winner;
        winningLine = terminal.winningLine;
        result = winner === null ? "draw" : winner === modelSymbol ? "model_wins" : "user_wins";
        const resultMessage =
          result === "draw"
            ? "It is a draw — good game!"
            : result === "model_wins"
              ? "The model wins — good game!"
              : "You win — well played!";
        const lastMove = moves.at(-1)!;
        yield* context.elicit("pickMove", {
          message: resultMessage,
          context: {
            board,
            moveHistory: moves,
            lastMove: { position: lastMove.position, player: lastMove.player },
            winningLine,
            gameOver: true,
            resultMessage,
            modelSymbol,
            userSymbol,
          },
        });
        break;
      }
      currentPlayer = currentPlayer === "X" ? "O" : "X";
    }

    const gamePath = `tic-tac-toe-game-${gameId}.json`;
    yield* assertGameDoesNotExist(context.workspace.readFile, gamePath);
    const existingRecord = yield* readRecord(context.workspace.readFile);
    if (existingRecord.games.length >= 1_000) {
      throw new CrankError("payload_too_large", "Tic-tac-toe record reached its game limit");
    }
    const game = GameFileSchema.parse({
      format: "yo-studio.tic-tac-toe-game.v2",
      gameId,
      modelSymbol,
      userSymbol,
      result,
      winner,
      winningLine,
      board,
      boardDisplay: formatBoard(board),
      moves,
    });
    const record: WinLossRecord = {
      ...existingRecord,
      gamesPlayed: existingRecord.gamesPlayed + 1,
      modelWins: existingRecord.modelWins + (result === "model_wins" ? 1 : 0),
      userWins: existingRecord.userWins + (result === "user_wins" ? 1 : 0),
      draws: existingRecord.draws + (result === "draw" ? 1 : 0),
      games: [...existingRecord.games, { gameId, result, gamePath }],
    };

    const observed = yield* context.workspace.inspect();
    const gameWrite = yield* context.record(
      {
        key: "yo-studio-play-ttt-write-game",
        retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
      },
      function* ({ pullId }) {
        return yield* context.workspace.writeFile(
          {
            path: gamePath,
            contents: `${canonicalJson(game)}\n`,
            expectedWorkspaceRevision: observed.workspaceRevision,
          },
          { operationId: pullId },
        );
      },
    );
    const recordWrite = yield* context.record(
      {
        key: "yo-studio-play-ttt-write-record",
        retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
      },
      function* ({ pullId }) {
        return yield* context.workspace.writeFile(
          {
            path: RECORD_PATH,
            contents: `${canonicalJson(record)}\n`,
            expectedWorkspaceRevision: gameWrite.workspaceRevision,
          },
          { operationId: pullId },
        );
      },
    );

    return {
      gameId,
      modelSymbol,
      userSymbol,
      result,
      winner,
      winningLine,
      board,
      boardDisplay: game.boardDisplay,
      gamePath,
      recordPath: RECORD_PATH,
      workspaceRevision: recordWrite.workspaceRevision,
    };
  });

function* assertGameDoesNotExist(
  readFile: WorkspaceFilesApi["readFile"],
  path: string,
): Operation<void> {
  try {
    yield* readFile({ path });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new CrankError("idempotency_conflict", `Tic-tac-toe game already exists: ${path}`);
}

function* readRecord(readFile: WorkspaceFilesApi["readFile"]): Operation<WinLossRecord> {
  try {
    const observed = yield* readFile({ path: RECORD_PATH });
    return WinLossRecordSchema.parse(JSON.parse(observed.contents));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        format: "yo-studio.tic-tac-toe-record.v1",
        gamesPlayed: 0,
        modelWins: 0,
        userWins: 0,
        draws: 0,
        games: [],
      };
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function gameStatus(board: Board): {
  readonly winner: Player | null;
  readonly draw: boolean;
  readonly winningLine: number[];
} {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    const player = board[a] ?? null;
    if (player !== null && player === board[b] && player === board[c]) {
      return { winner: player, draw: false, winningLine: [...line] };
    }
  }
  return {
    winner: null,
    draw: board.every((cell) => cell !== null),
    winningLine: [],
  };
}

function formatBoard(board: Board): string {
  const value = (position: number) => board[position] ?? String(position);
  return [
    `${value(0)} | ${value(1)} | ${value(2)}`,
    "---------",
    `${value(3)} | ${value(4)} | ${value(5)}`,
    "---------",
    `${value(6)} | ${value(7)} | ${value(8)}`,
  ].join("\n");
}

function randomGameId(): string {
  return `game-${Math.random().toString(36).slice(2, 12)}`;
}
