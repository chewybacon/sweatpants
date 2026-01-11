/**
 * TicTacToe Plugin
 *
 * Provides client-side elicitation handlers for the tictactoe tool.
 * Renders the interactive board and returns user's cell selection.
 */
import { makePlugin, getElicitContext } from '@sweatpants/framework/chat'
import { tictactoeTool } from './tool'
import { TicTacToeBoard } from './components/TicTacToeBoard'
import type { Board, LastMove } from './types'

// =============================================================================
// CONTEXT TYPES
// =============================================================================

type PickMoveContext = {
  board: Board
  lastMove?: LastMove
  winningLine?: number[]
  gameOver?: boolean
  [key: string]: unknown
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const tictactoePlugin = makePlugin(tictactoeTool)
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
