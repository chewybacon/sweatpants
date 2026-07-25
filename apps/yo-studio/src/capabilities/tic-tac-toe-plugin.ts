import { getElicitContext, makePlugin } from "@sweatpants/framework/chat";

import { TicTacToeGame } from "./tic-tac-toe-game.tsx";
import { playTttTool, type Board, type GameMove, type Player } from "./tic-tac-toe.ts";

interface PickMoveContext {
  readonly board: Board;
  readonly moveHistory: GameMove[];
  readonly lastMove?: { readonly position: number; readonly player: Player };
  readonly winningLine?: number[];
  readonly gameOver?: boolean;
  readonly resultMessage?: string;
  readonly modelSymbol: Player;
  readonly userSymbol: Player;
  readonly [key: string]: unknown;
}

/** Client projection for each durable pickMove elicitation. */
export const playTttPlugin = makePlugin(playTttTool)
  .onElicit({
    pickMove: function* (request, context) {
      const game = getElicitContext<PickMoveContext>(request);
      const response = yield* context.render(TicTacToeGame, {
        board: game.board,
        moveHistory: game.moveHistory,
        modelSymbol: game.modelSymbol,
        userSymbol: game.userSymbol,
        ...(game.lastMove ? { lastMove: game.lastMove } : {}),
        ...(game.winningLine ? { winningLine: game.winningLine } : {}),
        ...(game.gameOver !== undefined ? { gameOver: game.gameOver } : {}),
        ...(game.resultMessage ? { resultMessage: game.resultMessage } : {}),
      });
      return { action: "accept" as const, content: response };
    },
  })
  .build();
