/**
 * TicTacToe Plugin
 *
 * Provides client-side elicitation handlers for the tictactoe tool.
 * Uses the GameChatView component to render the game as a chat-style conversation.
 *
 * This is nearly identical to play-ttt's plugin - same UI, different tool logic.
 */
import { makePlugin, getElicitContext } from "@sweatpants/framework/chat";
import { tictactoeTool } from "./tool.ts";
import { GameChatView, type GameMove } from "../play-ttt/components/GameChatView.tsx";
import type { Board, Player } from "./types.ts";

// =============================================================================
// CONTEXT TYPES
// =============================================================================

interface PickMoveContext {
  board: Board;
  moveHistory: GameMove[];
  lastMove?: { position: number; player: Player };
  winningLine?: number[];
  gameOver?: boolean;
  resultMessage?: string;
  modelSymbol: Player;
  userSymbol: Player;
  [key: string]: unknown;
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const tictactoePlugin = makePlugin(tictactoeTool)
  .onElicit({
    /**
     * Handler for pickMove elicitation.
     * Renders the GameChatView component which shows move history and current board.
     */
    pickMove: function* (req, ctx) {
      // Extract context from x-elicit-context
      const context = getElicitContext<PickMoveContext>(req);
      const {
        board,
        moveHistory,
        lastMove,
        winningLine,
        gameOver,
        resultMessage,
        modelSymbol,
        userSymbol,
      } = context;

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
