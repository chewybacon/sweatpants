/**
 * Play TicTacToe Plugin
 *
 * Provides client-side elicitation handlers for the play_ttt tool.
 * Uses the GameChatView component to render the game as a chat-style conversation.
 */
import { makePlugin, getElicitContext } from '@sweatpants/framework/chat'
import { playTttTool } from './tool'
import { GameChatView, type GameMove } from './components/GameChatView'
import type { Board, Player } from '../tictactoe/types'

// =============================================================================
// CONTEXT TYPES
// =============================================================================

interface PickMoveContext {
  board: Board
  moveHistory: GameMove[]
  lastMove?: { position: number; player: Player }
  winningLine?: number[]
  gameOver?: boolean
  resultMessage?: string
  modelSymbol: Player
  userSymbol: Player
  [key: string]: unknown
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const playTttPlugin = makePlugin(playTttTool)
  .onElicit({
    /**
     * Handler for pickMove elicitation.
     * Renders the GameChatView component which shows move history and current board.
     */
    pickMove: function* (req, ctx) {
      // Extract context from x-model-context
      const context = getElicitContext<PickMoveContext>(req)
      const {
        board,
        moveHistory,
        lastMove,
        winningLine,
        gameOver,
        resultMessage,
        modelSymbol,
        userSymbol,
      } = context

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
      }

      // If game is over, render static view and auto-complete
      if (gameOver) {
        yield* ctx.render(GameChatView, props)
        // Return a dummy response (won't be used since game is over)
        return { action: 'accept' as const, content: { position: -1 } }
      }

      // Render the interactive view and wait for user selection
      const result = yield* ctx.render(GameChatView, props)

      // Return the selection as an accept response
      return { action: 'accept' as const, content: result }
    },
  })
  .build()
