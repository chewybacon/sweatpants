/**
 * TicTacToe Tool (MCP Plugin Pattern)
 *
 * Single tool that handles the complete tic-tac-toe game flow:
 * - Model plays as X, user plays as O
 * - Uses elicitation for user moves
 * - Game state managed in execute function
 *
 * Phase 1: No interrupt support (user can only click cells)
 */
import { z } from 'zod'
import { createMcpTool } from '@sweatpants/framework/chat'
import {
  type Board,
  type GameStatus,
  EMPTY_BOARD,
  checkWinner,
  applyMove,
  formatBoard,
} from './types'

// =============================================================================
// SCHEMAS
// =============================================================================

const CellSchema = z.union([z.literal('X'), z.literal('O'), z.null()])
// Use array with length constraint instead of tuple (OpenAI requires 'items' in array schemas)
const BoardSchema = z.array(CellSchema).length(9).describe('Board state: 9 cells, each X, O, or null')

const LastMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(['X', 'O']),
})

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const tictactoeTool = createMcpTool('tictactoe')
  .description(
    `Play tic-tac-toe with the user. You are X (go first), user is O.

Actions:
- start: Begin a new game with your opening move (position 0-8)
- move: Make a move on an existing board
- end: Announce the game result (call when game is over)

Board positions:
0 | 1 | 2
---------
3 | 4 | 5
---------
6 | 7 | 8

Tips: Center (4) or corners (0,2,6,8) are strong opening moves.`
  )
  .parameters(
    z.object({
      action: z.enum(['start', 'move', 'end']).describe('Game action to perform'),
      position: z
        .number()
        .min(0)
        .max(8)
        .optional()
        .describe('Your move position (0-8). Required for start, optional for move (null to just show board)'),
      board: BoardSchema.optional().describe('Current board state. Required for move/end actions'),
      winner: z.enum(['X', 'O', 'draw']).optional().describe('Game result. Required for end action'),
      winningLine: z.array(z.number()).optional().describe('Winning positions if not a draw'),
    })
  )
  .elicits({
    pickMove: {
      response: z.object({
        position: z.number().min(0).max(8).describe('Cell position user clicked'),
      }),
      context: z.object({
        board: BoardSchema,
        lastMove: LastMoveSchema.optional(),
        winningLine: z.array(z.number()).optional(),
        gameOver: z.boolean().optional(),
      }),
    },
  })
  .execute(function* (params, ctx) {
    const { action } = params

    // ==========================================================================
    // ACTION: START
    // ==========================================================================
    if (action === 'start') {
      if (params.position === undefined) {
        return {
          success: false,
          error: 'Position required for start action',
        }
      }

      // Apply model's opening move
      const board = applyMove(EMPTY_BOARD, params.position, 'X')
      const { status } = checkWinner(board)

      yield* ctx.notify('Game started! Your turn.', 0.5)

      // Elicit user's move
      const result = yield* ctx.elicit('pickMove', {
        message: "I've made my move. Click a cell to play!",
        board,
        lastMove: { position: params.position, player: 'X' },
      })

      // Handle decline/cancel
      if (result.action === 'decline' || result.action === 'cancel') {
        return {
          success: false,
          cancelled: true,
          board,
          boardDisplay: formatBoard(board),
          message: 'Game cancelled.',
        }
      }

      // Apply user's move
      const userPosition = result.content.position
      const newBoard = applyMove(board, userPosition, 'O')
      const gameResult = checkWinner(newBoard)

      return {
        success: true,
        board: newBoard,
        boardDisplay: formatBoard(newBoard),
        status: gameResult.status,
        userMove: userPosition,
        winningLine: gameResult.winningLine,
        hint:
          gameResult.status === 'ongoing'
            ? 'Game continues. Call tictactoe with action="move" and your next position.'
            : gameResult.status === 'o_wins'
              ? 'User won! Call tictactoe with action="end", winner="O".'
              : gameResult.status === 'draw'
                ? 'Draw! Call tictactoe with action="end", winner="draw".'
                : 'You won! Call tictactoe with action="end", winner="X".',
      }
    }

    // ==========================================================================
    // ACTION: MOVE
    // ==========================================================================
    if (action === 'move') {
      if (!params.board) {
        return {
          success: false,
          error: 'Board required for move action',
        }
      }

      let board = params.board as Board
      let lastMove = undefined

      // Apply model's move if position provided
      if (params.position !== undefined) {
        // Validate position is empty
        if (board[params.position] !== null) {
          return {
            success: false,
            error: `Invalid move: Position ${params.position} is already occupied by ${board[params.position]}. Choose an empty position (one that is null in the board array).`,
            board,
            boardDisplay: formatBoard(board),
            emptyPositions: board.map((cell, i) => cell === null ? i : null).filter(i => i !== null),
          }
        }
        board = applyMove(board, params.position, 'X')
        lastMove = { position: params.position, player: 'X' as const }
      }

      const { status, winningLine } = checkWinner(board)

      // If game ended from model's move, return immediately
      if (status !== 'ongoing') {
        return {
          success: true,
          board,
          boardDisplay: formatBoard(board),
          status,
          winningLine,
          hint:
            status === 'x_wins'
              ? 'You won! Call tictactoe with action="end", winner="X".'
              : 'Draw! Call tictactoe with action="end", winner="draw".',
        }
      }

      yield* ctx.notify("Your turn!", 0.5)

      // Elicit user's move
      const result = yield* ctx.elicit('pickMove', {
        message: params.position !== undefined
          ? "I've made my move. Your turn!"
          : "It's your turn. Click a cell!",
        board,
        lastMove,
      })

      // Handle decline/cancel
      if (result.action === 'decline' || result.action === 'cancel') {
        return {
          success: false,
          cancelled: true,
          board,
          boardDisplay: formatBoard(board),
          message: 'Game cancelled.',
        }
      }

      // Apply user's move
      const userPosition = result.content.position
      const newBoard = applyMove(board, userPosition, 'O')
      const gameResult = checkWinner(newBoard)

      return {
        success: true,
        board: newBoard,
        boardDisplay: formatBoard(newBoard),
        status: gameResult.status,
        userMove: userPosition,
        winningLine: gameResult.winningLine,
        hint:
          gameResult.status === 'ongoing'
            ? 'Game continues. Call tictactoe with action="move" and your next position.'
            : gameResult.status === 'o_wins'
              ? 'User won! Call tictactoe with action="end", winner="O".'
              : gameResult.status === 'draw'
                ? 'Draw! Call tictactoe with action="end", winner="draw".'
                : 'You won! Call tictactoe with action="end", winner="X".',
      }
    }

    // ==========================================================================
    // ACTION: END
    // ==========================================================================
    if (action === 'end') {
      if (!params.board || !params.winner) {
        return {
          success: false,
          error: 'Board and winner required for end action',
        }
      }

      // Show the final board state (no elicitation needed - fire and forget)
      // The client plugin will render a static winner banner
      const result = yield* ctx.elicit('pickMove', {
        message:
          params.winner === 'draw'
            ? "It's a draw! Good game!"
            : params.winner === 'X'
              ? 'I win! Better luck next time!'
              : 'You win! Great game!',
        board: params.board as Board,
        winningLine: params.winningLine,
        gameOver: true,
      })

      // User can decline/cancel to dismiss, doesn't matter
      return {
        success: true,
        gameOver: true,
        winner: params.winner,
        board: params.board,
        boardDisplay: formatBoard(params.board as Board),
        message:
          params.winner === 'draw'
            ? "It's a draw!"
            : params.winner === 'X'
              ? 'I win!'
              : 'You win!',
        hint: 'Game complete. You can offer a rematch by calling tictactoe with action="start".',
      }
    }

    return {
      success: false,
      error: `Unknown action: ${action}`,
    }
  })

// Result type
export type TicTacToeResult =
  | {
      success: true
      board: Board
      boardDisplay: string
      status: GameStatus
      userMove?: number
      winningLine?: number[]
      hint: string
      gameOver?: boolean
      winner?: 'X' | 'O' | 'draw'
      message?: string
    }
  | {
      success: false
      error?: string
      cancelled?: boolean
      board?: Board
      boardDisplay?: string
      message?: string
    }
