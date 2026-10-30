import { z } from "zod";
export const CellSchema = z.union([z.literal("X"), z.literal("O"), z.null()]);
export const BoardSchema = z
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
export const LastMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(["X", "O"]),
});
export const GameMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(["X", "O"]),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z.number(),
});

export const PickMoveResponseSchema = z.object({
  // -1 is used by the game-over UI acknowledgement.
  position: z.number().min(-1).max(8).describe("Cell position user clicked"),
});

export const PickMoveContextSchema = z.object({
  board: BoardSchema,
  moveHistory: z.array(GameMoveSchema).describe("History of all moves"),
  lastMove: LastMoveSchema.optional(),
  winningLine: z.array(z.number()).optional(),
  gameOver: z.boolean().optional(),
  resultMessage: z.string().optional(),
  modelSymbol: z.enum(["X", "O"]),
  userSymbol: z.enum(["X", "O"]),
});
