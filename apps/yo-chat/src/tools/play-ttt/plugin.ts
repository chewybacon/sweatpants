/**
 * Play TicTacToe Plugin
 *
 * Provides client-side elicitation handlers for the play_ttt tool.
 * Uses the GameChatView component to render the game as a chat-style conversation.
 */
import { makePlugin } from "@sweatpants/react-chat";
import { playTttTool } from "../primitive/play-ttt.ts";
import { GameChatView } from "./components/GameChatView";

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const playTttPlugin = makePlugin(playTttTool)
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
        lastMove,
        winningLine,
        gameOver,
        resultMessage,
      };

      // Render GameChatView. For game-over, the component auto-acks with
      // position -1 so the park resolves and follow-up chat is not blocked.
      const result = yield* ctx.render(GameChatView, props);
      return { action: "accept" as const, content: result };
    },
  })
  .build();
