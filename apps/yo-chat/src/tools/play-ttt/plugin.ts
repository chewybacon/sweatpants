/**
 * Play TicTacToe Plugin
 *
 * Provides client-side elicitation handlers for the play_ttt tool.
 * Reuses the TicTacToeBoard component from the tictactoe plugin.
 */
import { makePlugin, getElicitContext } from '@sweatpants/framework/chat'
import { playTttTool } from './tool'
import { TicTacToeBoard } from '../tictactoe/components/TicTacToeBoard'
import type { Board, LastMove, Player } from '../tictactoe/types'

// =============================================================================
// CONTEXT TYPES
// =============================================================================

interface PickMoveContext {
  board: Board
  lastMove?: LastMove
  winningLine?: number[]
  gameOver?: boolean
  modelSymbol?: Player
  userSymbol?: Player
  [key: string]: unknown
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const playTttPlugin = makePlugin(playTttTool)
  .onElicit({
    /**
     * Handler for pickMove elicitation.
     * Renders the TicTacToeBoard component and returns the selected position.
     */
    pickMove: function* (req, ctx) {
      // Extract context from x-model-context
      const context = getElicitContext<PickMoveContext>(req)
      const board = context.board
      const lastMove = context.lastMove
      const winningLine = context.winningLine
      const gameOver = context.gameOver

      // Build props, only including optional fields if they exist
      const baseProps = { board }
      const props = {
        ...baseProps,
        ...(lastMove !== undefined ? { lastMove } : {}),
        ...(winningLine !== undefined ? { winningLine } : {}),
        ...(gameOver !== undefined ? { gameOver } : {}),
      }

      // If game is over, render static board and auto-complete
      if (gameOver) {
        // Render the board in game-over state
        yield* ctx.render(TicTacToeBoard, { ...props, gameOver: true })
        
        // Return a dummy response (won't be used since game is over)
        return { action: 'accept' as const, content: { position: -1 } }
      }

      // Render the interactive board and wait for user selection
      const result = yield* ctx.render(TicTacToeBoard, props)

      // Return the selection as an accept response
      return { action: 'accept' as const, content: result }
    },
  })
  .build()
