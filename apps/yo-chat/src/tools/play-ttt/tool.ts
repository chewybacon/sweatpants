/**
 * Play TicTacToe Tool (Agentic Pattern)
 *
 * Canonical-core implementation of the original single-call game loop.
 * Uses canonical ctx.elicit() for user moves and the framework sampling
 * helpers (ctx.sampleTools / ctx.sampleSchema) for L1 strategy + L2 move
 * selection, just like the pre-refactor tool.
 */
import { createTool } from '@sweatpants/framework/chat'
import { z } from 'zod'
import {
  type Board,
  type Player,
  EMPTY_BOARD,
  checkWinner,
  applyMove,
  formatBoard,
} from '../tictactoe/types.ts'

// =============================================================================
// SCHEMAS
// =============================================================================

const CellSchema = z.union([z.literal('X'), z.literal('O'), z.null()])
const BoardSchema = z.array(CellSchema).length(9).describe('Board state: 9 cells')

const LastMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(['X', 'O']),
})

const GameMoveSchema = z.object({
  position: z.number().min(0).max(8),
  player: z.enum(['X', 'O']),
  isModel: z.boolean(),
  boardAfter: BoardSchema,
  moveNumber: z.number(),
  strategy: z.enum(['offensive', 'defensive']).optional(),
  reasoning: z.string().optional(),
})

const MoveSchema = z.object({
  cell: z.number().min(0).max(8).describe('Cell position to play (0-8)'),
})

type GameMove = z.infer<typeof GameMoveSchema>

type GameClientResult =
  | {
      cancelled: true
      board: Board
      boardDisplay: string
    }
  | {
      status: 'x_wins' | 'o_wins' | 'draw'
      winner: Player | null
      modelWon: boolean
      board: Board
      boardDisplay: string
      winningLine?: number[]
    }

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const playTttTool = createTool('play_ttt')
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
6 | 7 | 8`,
  )
  .parameters(z.object({}))
  .elicits({
    pickMove: {
      response: z.object({
        // -1 is used by the game-over UI acknowledgement.
        position: z.number().min(-1).max(8).describe('Cell position user clicked'),
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
  .samples()
  .execute(function* (_params, ctx) {
    const modelPlaysX = Math.random() < 0.5
    const modelSymbol = (modelPlaysX ? 'X' : 'O') as Player
    const userSymbol = (modelPlaysX ? 'O' : 'X') as Player
    const modelGoesFirst = modelPlaysX

    let board: Board = [...EMPTY_BOARD]
    let currentPlayer: Player = 'X'
    const moveHistory: GameMove[] = []
    const samplingCtx = ctx as typeof ctx & {
      sampleTools(config: Record<string, unknown>): ReturnType<typeof ctx.sample>
      sampleSchema<T>(config: Record<string, unknown>): ReturnType<typeof ctx.sample> & { parsed?: T }
    }

    yield* ctx.log('info', `Game started! Model plays ${modelSymbol}, User plays ${userSymbol}`)

    let clientResult: GameClientResult

    while (true) {
      const isModelTurn = currentPlayer === modelSymbol

      if (isModelTurn) {
        // =================================================================
        // MODEL'S TURN: L1 Strategy -> L2 Move
        // =================================================================
        yield* ctx.notify('Model is thinking...', 0.5)

        const boardStr = formatBoard(board)
        const emptyPositions = board
          .map((cell, i) => (cell === null ? i : null))
          .filter((i): i is number => i !== null)

        // L1: Strategy decision using tool calling.
        const strategy = (yield* samplingCtx.sampleTools({
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
        })) as unknown as { toolCalls: [{ id: string; name: string; arguments: Record<string, unknown> }, ...Array<{ id: string; name: string; arguments: Record<string, unknown> }>] }

        const chosenStrategy = strategy.toolCalls[0]
        const strategyName: 'offensive' | 'defensive' =
          chosenStrategy.name === 'play_offensive' ? 'offensive' : 'defensive'
        const args = chosenStrategy.arguments as { reasoning?: string; threat?: string }
        const reasoning = args.reasoning || args.threat

        yield* ctx.log('info', `Strategy: ${chosenStrategy.name}`)

        // L2: Move selection using schema.
        const moveResult = (yield* samplingCtx.sampleSchema<{ cell: number }>({
          messages: [
            {
              role: 'user',
              content: `Board:\n${boardStr}\n\nEmpty positions: ${emptyPositions.join(', ')}\n\nPick your move.`,
            },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: chosenStrategy.id,
                  type: 'function',
                  function: {
                    name: chosenStrategy.name,
                    arguments: chosenStrategy.arguments,
                  },
                },
              ],
            },
            {
              role: 'tool',
              content: `Strategy chosen: ${chosenStrategy.name}. Now pick a cell (0-8) from empty positions.`,
              tool_call_id: chosenStrategy.id,
            },
          ],
          schema: MoveSchema,
          retries: 3,
        })) as { parsed: { cell: number } }

        let playedCell = moveResult.parsed.cell

        // Preserve the original guard against malformed model moves.
        if (!emptyPositions.includes(playedCell)) {
          yield* ctx.log('warning', `Model chose occupied cell ${playedCell}, falling back to first empty`)
          playedCell = emptyPositions[0]!
        }

        board = applyMove(board, playedCell, modelSymbol)
        yield* ctx.log('info', `Model plays cell ${playedCell}`)

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
        const lastEntry = moveHistory[moveHistory.length - 1]
        const lastMove = lastEntry
          ? { position: lastEntry.position, player: lastEntry.player }
          : undefined

        const result = yield* ctx.elicit('pickMove', {
          message:
            modelGoesFirst && board.filter((cell) => cell !== null).length === 1
              ? `I'm ${modelSymbol}! I made the first move. Your turn as ${userSymbol}!`
              : `Your turn! You're playing as ${userSymbol}.`,
          context: {
            board,
            moveHistory,
            ...(lastMove ? { lastMove } : {}),
            modelSymbol,
            userSymbol,
          },
        })

        if (result.action === 'decline' || result.action === 'cancel') {
          clientResult = {
            cancelled: true,
            board,
            boardDisplay: formatBoard(board),
          }
          break
        }

        const userPosition = result.content.position
        board = applyMove(board, userPosition, userSymbol)
        yield* ctx.log('info', `User plays cell ${userPosition}`)

        moveHistory.push({
          position: userPosition,
          player: userSymbol,
          isModel: false,
          boardAfter: [...board],
          moveNumber: moveHistory.length + 1,
        })
      }

      const { status, winningLine } = checkWinner(board)
      if (status !== 'ongoing') {
        const resultMessage =
          status === 'draw'
            ? "It's a draw! Good game!"
            : status === 'x_wins'
              ? modelSymbol === 'X'
                ? 'I win! Good game!'
                : 'You win! Well played!'
              : modelSymbol === 'O'
                ? 'I win! Good game!'
                : 'You win! Well played!'

        const lastEntry = moveHistory[moveHistory.length - 1]
        const lastMove = lastEntry
          ? { position: lastEntry.position, player: lastEntry.player }
          : undefined

        yield* ctx.elicit('pickMove', {
          message: resultMessage,
          context: {
            board,
            moveHistory,
            ...(lastMove ? { lastMove } : {}),
            ...(winningLine ? { winningLine } : {}),
            gameOver: true,
            resultMessage,
            modelSymbol,
            userSymbol,
          },
        })

        clientResult = {
          status,
          winner: status === 'draw' ? null : status === 'x_wins' ? 'X' : 'O',
          modelWon:
            status !== 'draw' &&
            ((status === 'x_wins' && modelSymbol === 'X') ||
              (status === 'o_wins' && modelSymbol === 'O')),
          board,
          boardDisplay: formatBoard(board),
          ...(winningLine ? { winningLine } : {}),
        }
        break
      }

      currentPlayer = currentPlayer === 'X' ? 'O' : 'X'
    }

    if ('cancelled' in clientResult) {
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
      result:
        clientResult.status === 'draw'
          ? 'draw'
          : clientResult.modelWon
            ? 'model_wins'
            : 'user_wins',
      winner: clientResult.winner,
      board: clientResult.board,
      boardDisplay: clientResult.boardDisplay,
      winningLine: clientResult.winningLine,
      message:
        clientResult.status === 'draw'
          ? 'The game ended in a draw!'
          : clientResult.modelWon
            ? 'I won the game!'
            : 'The user won the game!',
    }
  })

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
