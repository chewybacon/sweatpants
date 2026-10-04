import { makePlugin } from "@sweatpants/react-chat";

import { TicTacToeGame } from "./tic-tac-toe-game.tsx";
import { playTttTool } from "./tic-tac-toe.ts";

/** Client projection for each durable pickMove elicitation. */
export const playTttPlugin = makePlugin(playTttTool)
  .onElicit({
    pickMove: function* (input, context) {
      const game = input.context;
      const response = yield* context.render(TicTacToeGame, {
        board: game.board,
        moveHistory: game.moveHistory,
        modelSymbol: game.modelSymbol,
        userSymbol: game.userSymbol,
        lastMove: game.lastMove,
        winningLine: game.winningLine,
        gameOver: game.gameOver,
        resultMessage: game.resultMessage || undefined,
      });
      return { action: "accept" as const, content: response };
    },
  })
  .build();
