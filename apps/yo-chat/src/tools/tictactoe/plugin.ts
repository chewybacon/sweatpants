/**
 * TicTacToe Plugin
 *
 * Provides client-side elicitation handlers for the tictactoe tool.
 * Uses the GameChatView component to render the game as a chat-style conversation.
 *
 * This is nearly identical to play-ttt's plugin - same UI, different tool logic.
 */
import { makePlugin } from "@sweatpants/react-chat";
import { tictactoeTool } from "./tool.ts";
import { GameChatView } from "../play-ttt/components/GameChatView.tsx";

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const tictactoePlugin = makePlugin(tictactoeTool)
  .onElicit({
    /**
     * Handler for pickMove elicitation.
     * Renders the GameChatView component which shows move history and current board.
     */
    pickMove: function* (input, ctx) {
      const {
        board,
        moveHistory,
        lastMove,
        winningLine,
        gameOver,
        resultMessage,
        modelSymbol,
        userSymbol,
      } = input.context;

      // Build props for GameChatView
      const props = {
        board,
        moveHistory: moveHistory || [],
        userSymbol,
        modelSymbol,
        ...(lastMove !== undefined ? { lastMove } : {}),
        ...(winningLine !== undefined ? { winningLine } : {}),
        ...(gameOver !== undefined ? { gameOver } : {}),
        ...(resultMessage !== undefined ? { resultMessage } : {}),
      };

      // Render GameChatView. For game-over, the component auto-acks with
      // position -1 so the park resolves and follow-up chat is not blocked.
      const result = yield* ctx.render(GameChatView, props);
      return { action: "accept" as const, content: result };
    },
  })
  .build();
