/**
 * TicTacToe Tool (MCP Standard Sampling)
 *
 * A single tool call that plays an entire tic-tac-toe game.
 * Uses ONLY standard MCP sampling (no structured output, no tool forcing).
 *
 * This demonstrates the limitations of plain MCP sampling:
 * - Model must respond with free-form text
 * - We parse the response hoping for a valid move
 * - No retries, no guarantees - if parsing fails, we fallback to random
 *
 * Compare this to play-ttt which uses MCP++ extensions (sampleTools, sampleSchema)
 * for guaranteed structured responses and strategic decision making.
 */
import { z } from 'zod'
import { createMcpTool } from '@sweatpants/framework/chat'
import {
  type Board,
  type Player,
  EMPTY_BOARD,
  checkWinner,
  applyMove,
  formatBoard,
} from './types.ts'

// =============================================================================
// SCHEMAS
// =============================================================================

const CellSchema = z.union([z.literal('X'), z.literal('O'), z.null()])
const BoardSchema = z.array(CellSchema).length(9).describe('Board state: 9 cells')

const LastMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(['X', 'O']),
})

/** Schema for a single move in history */
const GameMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(['X', 'O']),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z.number(),
})

/** Type for a single move in history */
type GameMove = z.infer<typeof GameMoveSchema>

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const tictactoeTool = createMcpTool('tictactoe')
  .description(
    `Play a complete game of tic-tac-toe against the user.

This tool handles the entire game - just call it once and it will:
1. Randomly assign X or O to you and the user
2. Take turns until someone wins or draws
3. Return the final result

You'll pick moves by responding with a cell number. The user will pick their moves interactively.

Board positions:
0 | 1 | 2
---------
3 | 4 | 5
---------
6 | 7 | 8`
  )
  .parameters(z.object({}))
  .elicits({
    pickMove: {
      response: z.object({
        position: z.number().min(0).max(8).describe('Cell position user clicked'),
      }),
      context: z.object({
        board: BoardSchema,
        moveHistory: z.array(GameMoveSchema).describe('History of all moves'),
        lastMove: LastMoveSchema.optional(),
        winningLine: z.array(z.number()).optional(),
        gameOver: z.boolean().optional(),
        resultMessage: z.string().optional(),
        modelSymbol: z.enum(['X', 'O']),
        userSymbol: z.enum(['X', 'O']),
      }),
    },
  })
  .handoff({
    /**
     * Phase 1: before()
     * Randomly assign X/O to model and user.
     * X always goes first.
     */
    *before(_params, _ctx) {
      const modelPlaysX = Math.random() < 0.5
      return {
        modelSymbol: modelPlaysX ? 'X' as Player : 'O' as Player,
        userSymbol: modelPlaysX ? 'O' as Player : 'X' as Player,
        modelGoesFirst: modelPlaysX, // X goes first
      }
    },

    /**
     * Client phase: Main game loop
     * Alternates between model and user moves until game ends.
     * 
     * KEY DIFFERENCE FROM play-ttt:
     * - Uses plain ctx.sample() - just free-form text response
     * - No structured output (schema), no tool forcing
     * - Must parse the response and hope for the best
     * - Falls back to random if parsing fails
     */
    *client(handoff, ctx) {
      const { modelSymbol, userSymbol, modelGoesFirst } = handoff
      let board: Board = [...EMPTY_BOARD]
      let currentPlayer: Player = 'X' // X always goes first
      const moveHistory: GameMove[] = []

      yield* ctx.log('info', `Game started! Model plays ${modelSymbol}, User plays ${userSymbol}`)

      // Game loop
      while (true) {
        const isModelTurn = currentPlayer === modelSymbol

        if (isModelTurn) {
          // =================================================================
          // MODEL'S TURN: Plain MCP Sampling (no structured output)
          // =================================================================
          yield* ctx.notify(`Model is thinking...`, 0.5)

          const boardStr = formatBoard(board)
          const emptyPositions = board
            .map((cell, i) => (cell === null ? i : null))
            .filter((i): i is number => i !== null)

          // Plain sampling - just ask for a number, hope for the best
          const response = yield* ctx.sample({
            prompt: `You are playing tic-tac-toe as ${modelSymbol}.

Current board:
${boardStr}

Empty positions: ${emptyPositions.join(', ')}

Reply with ONLY a single digit (0-8) for your move. Nothing else.`,
          })

          yield* ctx.log('info', `Model response: "${response.text}"`)

          // Parse the response - best effort regex for a digit
          const match = response.text.match(/\b([0-8])\b/)
          let playedCell: number

          if (match) {
            const parsed = parseInt(match[1]!, 10)
            if (emptyPositions.includes(parsed)) {
              playedCell = parsed
              yield* ctx.log('info', `Parsed valid move: ${playedCell}`)
            } else {
              // Model picked an occupied cell - fallback to random
              yield* ctx.log('warning', `Model chose occupied cell ${parsed}, falling back to random`)
              playedCell = emptyPositions[Math.floor(Math.random() * emptyPositions.length)]!
            }
          } else {
            // Couldn't parse a number - fallback to random
            yield* ctx.log('warning', `Could not parse move from "${response.text}", falling back to random`)
            playedCell = emptyPositions[Math.floor(Math.random() * emptyPositions.length)]!
          }

          board = applyMove(board, playedCell, modelSymbol)
          yield* ctx.log('info', `Model plays cell ${playedCell}`)

          // Add model's move to history (no strategy - that's the point!)
          moveHistory.push({
            position: playedCell,
            player: modelSymbol,
            isModel: true,
            boardAfter: [...board],
            moveNumber: moveHistory.length + 1,
          })
        } else {
          // =================================================================
          // USER'S TURN: Elicitation
          // =================================================================
          const lastMove = moveHistory.length > 0
            ? { position: moveHistory[moveHistory.length - 1]!.position, player: moveHistory[moveHistory.length - 1]!.player }
            : undefined

          const result = yield* ctx.elicit('pickMove', {
            message: modelGoesFirst && board.filter(c => c !== null).length === 1
              ? `I'm ${modelSymbol}! I made the first move. Your turn as ${userSymbol}!`
              : `Your turn! You're playing as ${userSymbol}.`,
            board,
            moveHistory,
            lastMove,
            modelSymbol,
            userSymbol,
          })

          if (result.action === 'decline' || result.action === 'cancel') {
            return {
              cancelled: true,
              board,
              boardDisplay: formatBoard(board),
            }
          }

          const userPosition = result.content.position
          board = applyMove(board, userPosition, userSymbol)
          yield* ctx.log('info', `User plays cell ${userPosition}`)

          // Add user's move to history
          moveHistory.push({
            position: userPosition,
            player: userSymbol,
            isModel: false,
            boardAfter: [...board],
            moveNumber: moveHistory.length + 1,
          })
        }

        // Check for game end
        const { status, winningLine } = checkWinner(board)
        if (status !== 'ongoing') {
          const resultMessage = status === 'draw'
            ? "It's a draw! Good game!"
            : status === 'x_wins'
              ? modelSymbol === 'X' ? 'I win! Good game!' : 'You win! Well played!'
              : modelSymbol === 'O' ? 'I win! Good game!' : 'You win! Well played!'

          // Show final board to user
          yield* ctx.elicit('pickMove', {
            message: resultMessage,
            board,
            moveHistory,
            winningLine,
            gameOver: true,
            resultMessage,
            modelSymbol,
            userSymbol,
          })

          return {
            status,
            winner: status === 'draw' ? null : (status === 'x_wins' ? 'X' : 'O'),
            modelWon: status !== 'draw' &&
              ((status === 'x_wins' && modelSymbol === 'X') ||
               (status === 'o_wins' && modelSymbol === 'O')),
            board,
            boardDisplay: formatBoard(board),
            winningLine,
          }
        }

        // Switch turns
        currentPlayer = currentPlayer === 'X' ? 'O' : 'X'
      }
    },

    /**
     * Phase 2: after()
     * Format the final result for the LLM.
     */
    *after(handoff, clientResult, _ctx, _params) {
      const { modelSymbol, userSymbol } = handoff

      if (clientResult.cancelled) {
        return {
          success: false,
          cancelled: true,
          message: 'Game was cancelled by the user.',
          board: clientResult.board,
          boardDisplay: clientResult.boardDisplay,
        }
      }

      return {
        success: true,
        modelSymbol,
        userSymbol,
        result: clientResult.status === 'draw'
          ? 'draw'
          : clientResult.modelWon
            ? 'model_wins'
            : 'user_wins',
        winner: clientResult.winner,
        board: clientResult.board,
        boardDisplay: clientResult.boardDisplay,
        winningLine: clientResult.winningLine,
        message: clientResult.status === 'draw'
          ? "The game ended in a draw!"
          : clientResult.modelWon
            ? "I won the game!"
            : "The user won the game!",
      }
    },
  })

// Result type for external consumers
export type TicTacToeResult =
  | {
      success: true
      modelSymbol: Player
      userSymbol: Player
      result: 'model_wins' | 'user_wins' | 'draw'
      winner: Player | null
      board: Board
      boardDisplay: string
      winningLine?: number[]
      message: string
    }
  | {
      success: false
      cancelled: true
      message: string
      board?: Board
      boardDisplay?: string
    }
