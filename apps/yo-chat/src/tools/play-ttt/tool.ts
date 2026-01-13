/**
 * Play TicTacToe Tool (Agentic Pattern)
 *
 * A single tool call that plays an entire tic-tac-toe game.
 * Uses the L1/L2 sampling pattern for AI decision making:
 *
 * - L1 (tools): Strategy decision (offensive vs defensive)
 * - L2 (schema): Move selection based on strategy
 * - Elicitation: User moves
 *
 * The model and user take turns until the game ends.
 * Random X/O assignment happens in before() phase.
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
} from '../tictactoe/types'

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
  strategy: z.enum(['offensive', 'defensive']).optional(),
  reasoning: z.string().optional(),
})

/** Schema for L2: Move selection */
const MoveSchema = z.object({
  cell: z.number().min(0).max(8).describe('Cell position to play (0-8)'),
})

/** Type for a single move in history */
type GameMove = z.infer<typeof GameMoveSchema>

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const playTttTool = createMcpTool('play_ttt')
  .description(
    `Play a complete game of tic-tac-toe against the user.

This tool handles the entire game - just call it once and it will:
1. Randomly assign X or O to you and the user
2. Take turns until someone wins or draws
3. Return the final result

You'll use your AI reasoning to pick moves. The user will pick their moves interactively.

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
          // MODEL'S TURN: L1 Strategy -> L2 Move
          // =================================================================
          yield* ctx.notify(`Model is thinking...`, 0.5)

          const boardStr = formatBoard(board)
          const emptyPositions = board
            .map((cell, i) => (cell === null ? i : null))
            .filter((i): i is number => i !== null)

          // L1: Strategy decision using tool calling (guaranteed to return tool calls)
          const strategy = yield* ctx.sampleTools({
            prompt: `You are playing tic-tac-toe as ${modelSymbol}.

Current board:
${boardStr}

Empty positions: ${emptyPositions.join(', ')}

Analyze the board and choose your strategy.`,
            tools: [
              {
                name: 'play_offensive',
                description: 'Go for the win - look for winning moves or set up future wins',
                inputSchema: z.object({
                  reasoning: z.string().describe('Why offensive play is best here'),
                }),
              },
              {
                name: 'play_defensive',
                description: 'Block opponent threats - prevent them from winning',
                inputSchema: z.object({
                  threat: z.string().describe('What threat are you blocking'),
                }),
              },
            ],
            retries: 3,
          })

          // sampleTools guarantees toolCalls[0] exists
          const chosenStrategy = strategy.toolCalls[0]
          let playedCell: number
          let strategyName: 'offensive' | 'defensive'
          let reasoning: string | undefined

          yield* ctx.log('info', `Strategy: ${chosenStrategy.name}`)
          strategyName = chosenStrategy.name === 'play_offensive' ? 'offensive' : 'defensive'
          const args = chosenStrategy.arguments as { reasoning?: string; threat?: string }
          reasoning = args.reasoning || args.threat

          // L2: Move selection using schema (guaranteed to parse successfully)
          const moveResult = yield* ctx.sampleSchema({
            messages: [
              {
                role: 'user',
                content: `Board:\n${boardStr}\n\nEmpty positions: ${emptyPositions.join(', ')}\n\nPick your move.`,
              },
              {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: chosenStrategy.id,
                  type: 'function',
                  function: {
                    name: chosenStrategy.name,
                    arguments: chosenStrategy.arguments as Record<string, unknown>,
                  },
                }],
              },
              {
                role: 'tool',
                content: `Strategy chosen: ${chosenStrategy.name}. Now pick a cell (0-8) from empty positions.`,
                tool_call_id: chosenStrategy.id,
              },
            ] as any, // Using any because Message type doesn't include tool_calls
            schema: MoveSchema,
            retries: 3,
          })

          // sampleSchema guarantees parsed is non-null and valid
          playedCell = moveResult.parsed.cell
          
          // Validate the move is actually empty (defense against hallucinated positions)
          if (!emptyPositions.includes(playedCell)) {
            yield* ctx.log('warning', `Model chose occupied cell ${playedCell}, falling back to first empty`)
            playedCell = emptyPositions[0]!
          }
          
          board = applyMove(board, playedCell, modelSymbol)
          yield* ctx.log('info', `Model plays cell ${playedCell}`)

          // Add model's move to history
          moveHistory.push({
            position: playedCell,
            player: modelSymbol,
            isModel: true,
            boardAfter: [...board],
            moveNumber: moveHistory.length + 1,
            strategy: strategyName,
            reasoning,
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
export type PlayTttResult = 
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
