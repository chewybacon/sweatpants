import { z } from "zod";
export const CellSchema = z.union([z.literal("X"), z.literal("O"), z.null()]);
export const BoardSchema = z.tuple([
  CellSchema,
  CellSchema,
  CellSchema,
  CellSchema,
  CellSchema,
  CellSchema,
  CellSchema,
  CellSchema,
  CellSchema,
]);
export const LastMoveSchema = z.object({
  position: z.number().int().min(0).max(8),
  player: z.enum(["X", "O"]),
});
export const GameMoveSchema = z.object({
  position: z.number().int().min(0).max(8),
  player: z.enum(["X", "O"]),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z.number().int().positive(),
  reasoning: z.string().optional(),
});
export const PickMoveResponseSchema = z.object({
  // -1 acknowledges the terminal board.
  position: z.number().int().min(-1).max(8),
});
export const ModelCellSchema = z.object({ cell: z.number().int().min(0).max(8) });
export const PickMoveContextSchema = z.object({
  board: BoardSchema,
  moveHistory: z.array(GameMoveSchema),
  lastMove: LastMoveSchema.optional(),
  winningLine: z.array(z.number().int()).optional(),
  gameOver: z.boolean().optional(),
  resultMessage: z.string().optional(),
  modelSymbol: z.enum(["X", "O"]),
  userSymbol: z.enum(["X", "O"]),
});
export const PlayTttResultSchema = z.union([
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
