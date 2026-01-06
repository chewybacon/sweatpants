/**
 * Tic-Tac-Toe Game Tools
 *
 * A demonstration of interactive game tools using ctx.render() pattern.
 * The model plays as X, the user plays as O. 
 * 
 * Tools:
 * - startTttGame: Initialize a new game, model can make first move
 * - tttMove: Model makes a move, waits for user response
 * - tttWinner: Announce the winner (fire-and-forget)
 */
import { createIsomorphicTool } from '@sweatpants/framework/chat/isomorphic-tools'
import type { RenderableProps } from '@sweatpants/framework/chat/isomorphic-tools'
import { z } from 'zod'
import { useEffect } from 'react'

// =============================================================================
// TYPES
// =============================================================================

type Cell = 'X' | 'O' | null
type Board = [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell]
type GameStatus = 'ongoing' | 'x_wins' | 'o_wins' | 'draw'

/** User can click a cell OR type a message */
type TttResponse =
  | { type: 'move'; position: number }
  | { type: 'message'; text: string }

// =============================================================================
// GAME LOGIC
// =============================================================================

const EMPTY_BOARD: Board = [null, null, null, null, null, null, null, null, null]

const WINNING_LINES = [
  [0, 1, 2], // rows
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6], // columns
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8], // diagonals
  [2, 4, 6],
]

function checkWinner(board: Board): { status: GameStatus; winningLine?: number[] } {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line as [number, number, number]
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return {
        status: board[a] === 'X' ? 'x_wins' : 'o_wins',
        winningLine: line,
      }
    }
  }

  if (board.every((cell) => cell !== null)) {
    return { status: 'draw' }
  }

  return { status: 'ongoing' }
}

function applyMove(board: Board, position: number, player: 'X' | 'O'): Board {
  if (board[position] !== null) {
    throw new Error(`Position ${position} is already occupied`)
  }
  const newBoard = [...board] as Board
  newBoard[position] = player
  return newBoard
}

function formatBoard(board: Board): string {
  const symbols = board.map((cell, i) => (cell === null ? String(i) : cell))
  return [
    `${symbols[0]} | ${symbols[1]} | ${symbols[2]}`,
    '---------',
    `${symbols[3]} | ${symbols[4]} | ${symbols[5]}`,
    '---------',
    `${symbols[6]} | ${symbols[7]} | ${symbols[8]}`,
  ].join('\n')
}

// =============================================================================
// COMPONENTS
// =============================================================================

interface BoardProps extends RenderableProps<TttResponse> {
  board: Board
  lastMove?: { position: number; player: 'X' | 'O' }
  winningLine?: number[]
}

function TicTacToeBoard({ board, lastMove, winningLine, onRespond, disabled, response }: BoardProps) {
  const renderCell = (position: number) => {
    const cell = board[position]
    const isWinningCell = winningLine?.includes(position)
    const isLastMove = lastMove?.position === position
    const isUserMove = response?.type === 'move' && response.position === position

    // Determine cell styling
    let cellStyle = 'w-16 h-16 text-2xl font-bold border border-slate-600 '

    if (isWinningCell) {
      cellStyle += 'bg-emerald-900/50 text-emerald-400 '
    } else if (isLastMove) {
      cellStyle += 'bg-cyan-900/30 '
    } else if (isUserMove) {
      cellStyle += 'bg-purple-900/30 '
    }

    if (cell === 'X') {
      cellStyle += 'text-cyan-400 '
    } else if (cell === 'O') {
      cellStyle += 'text-purple-400 '
    }

    // Interactive or static
    if (disabled || cell !== null) {
      return (
        <div key={position} className={cellStyle + 'flex items-center justify-center'}>
          {cell || ''}
        </div>
      )
    }

    return (
      <button
        key={position}
        onClick={() => onRespond({ type: 'move', position })}
        className={cellStyle + 'hover:bg-slate-700 cursor-pointer transition-colors flex items-center justify-center text-slate-600'}
      >
        {position}
      </button>
    )
  }

  return (
    <div className="my-3 p-4 bg-slate-800/50 rounded-lg inline-block">
      <div className="grid grid-cols-3 gap-1">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(renderCell)}
      </div>
      {!disabled && (
        <p className="text-xs text-slate-500 mt-2">Click a cell or type a message below</p>
      )}
      {disabled && response?.type === 'move' && (
        <p className="text-xs text-slate-500 mt-2">You played position {response.position}</p>
      )}
      {disabled && response?.type === 'message' && (
        <p className="text-xs text-slate-500 mt-2">You said: "{response.text}"</p>
      )}
    </div>
  )
}

TicTacToeBoard.displayName = 'TicTacToeBoard'

interface WinnerProps extends RenderableProps<void> {
  winner: 'X' | 'O' | 'draw'
  board: Board
  winningLine?: number[]
}

function WinnerBanner({ winner, board, winningLine, onRespond, disabled }: WinnerProps) {
  // Fire-and-forget: resolve immediately (only if not already disabled/complete)
  useEffect(() => {
    if (!disabled && onRespond) {
      onRespond(undefined)
    }
  }, [onRespond, disabled])

  const message =
    winner === 'draw'
      ? "It's a draw!"
      : winner === 'X'
        ? '🏆 X wins!'
        : '🏆 O wins!'

  const subtext =
    winner === 'X'
      ? 'The model wins this round.'
      : winner === 'O'
        ? 'You win this round!'
        : 'A hard-fought battle.'

  return (
    <div className="my-3 p-4 bg-slate-800/50 rounded-lg">
      <div className="text-2xl font-bold text-center mb-2">{message}</div>
      <p className="text-sm text-slate-400 text-center mb-3">{subtext}</p>
      <div className="flex justify-center">
        <div className="grid grid-cols-3 gap-1">
          {board.map((cell, i) => {
            const isWinning = winningLine?.includes(i)
            return (
              <div
                key={i}
                className={`w-12 h-12 text-xl font-bold border border-slate-600 flex items-center justify-center
                  ${isWinning ? 'bg-emerald-900/50 text-emerald-400' : ''}
                  ${cell === 'X' ? 'text-cyan-400' : cell === 'O' ? 'text-purple-400' : ''}
                `}
              >
                {cell || ''}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

WinnerBanner.displayName = 'WinnerBanner'

// =============================================================================
// TOOLS
// =============================================================================

/**
 * Start a new tic-tac-toe game.
 * Model plays as X, user plays as O.
 */
export const startTttGame = createIsomorphicTool('start_ttt_game')
  .description(
    'Start a new tic-tac-toe game. You play as X (first), user plays as O. ' +
    'Positions are numbered 0-8 (top-left to bottom-right). ' +
    'Returns the board state and waits for user move or message.'
  )
  .parameters(
    z.object({
      position: z
        .number()
        .min(0)
        .max(8)
        .describe('Your opening move (0-8). Center (4) or corners (0,2,6,8) are strong starts.'),
    })
  )
  .context('browser')
  .authority('server')
  .approval({ client: 'none' })
  .handoff({
    *before(params) {
      const board = applyMove(EMPTY_BOARD, params.position, 'X')
      const { status } = checkWinner(board)
      return {
        board,
        status,
        lastMove: { position: params.position, player: 'X' as const },
      }
    },

    *client(handoff, ctx: any) {
      const result: TttResponse = yield* ctx.render(TicTacToeBoard, {
        board: handoff.board,
        lastMove: handoff.lastMove,
      })
      return result
    },

    *after(handoff, clientResult: TttResponse) {
      if (clientResult.type === 'message') {
        return {
          board: handoff.board,
          boardDisplay: formatBoard(handoff.board),
          status: 'awaiting_user_move' as const,
          userMessage: clientResult.text,
          hint: 'User sent a message instead of moving. Respond conversationally, then call ttt_move with the same board and your next move (or null to just show the board again).',
        }
      }

      const newBoard = applyMove(handoff.board, clientResult.position, 'O')
      const { status, winningLine } = checkWinner(newBoard)

      return {
        board: newBoard,
        boardDisplay: formatBoard(newBoard),
        status,
        userMove: clientResult.position,
        winningLine,
        hint:
          status === 'ongoing'
            ? 'Game continues. Call ttt_move with your next move.'
            : status === 'o_wins'
              ? 'User won! Call ttt_winner to announce.'
              : status === 'draw'
                ? "It's a draw! Call ttt_winner to announce."
                : 'You won! Call ttt_winner to announce.',
      }
    },
  })

/**
 * Make a move in tic-tac-toe.
 */
export const tttMove = createIsomorphicTool('ttt_move')
  .description(
    'Make your move in tic-tac-toe. Pass the current board state and your move position (0-8). ' +
    'Set position to null if you just want to show the board without making a move (e.g., after responding to user chat). ' +
    'Returns updated board and waits for user response.'
  )
  .parameters(
    z.object({
      board: z
        .array(z.union([z.literal('X'), z.literal('O'), z.null()]))
        .length(9)
        .describe('Current board state, array of 9 cells'),
      position: z
        .number()
        .min(0)
        .max(8)
        .nullable()
        .describe('Your move position (0-8), or null to just display the board'),
    })
  )
  .context('browser')
  .authority('server')
  .approval({ client: 'none' })
  .handoff({
    *before(params) {
      let board = params.board as Board
      let lastMove: { position: number; player: 'X' | 'O' } | undefined

      if (params.position !== null) {
        board = applyMove(board, params.position, 'X')
        lastMove = { position: params.position, player: 'X' }
      }

      const { status, winningLine } = checkWinner(board)

      return {
        board,
        status,
        lastMove,
        winningLine,
      }
    },

    *client(handoff, ctx: any) {
      // If game is over, don't wait for user input
      if (handoff.status !== 'ongoing') {
        return { type: 'move' as const, position: -1 } // Dummy, won't be used
      }

      const result: TttResponse = yield* ctx.render(TicTacToeBoard, {
        board: handoff.board,
        lastMove: handoff.lastMove,
      })
      return result
    },

    *after(handoff, clientResult: TttResponse) {
      // Game already over from model's move
      if (handoff.status !== 'ongoing') {
        return {
          board: handoff.board,
          boardDisplay: formatBoard(handoff.board),
          status: handoff.status,
          winningLine: handoff.winningLine,
          hint:
            handoff.status === 'x_wins'
              ? 'You won! Call ttt_winner to announce.'
              : handoff.status === 'draw'
                ? "It's a draw! Call ttt_winner to announce."
                : 'Unexpected state.',
        }
      }

      if (clientResult.type === 'message') {
        return {
          board: handoff.board,
          boardDisplay: formatBoard(handoff.board),
          status: 'awaiting_user_move' as const,
          userMessage: clientResult.text,
          hint: 'User sent a message. Respond, then call ttt_move with position=null to show the board again, or make your move if appropriate.',
        }
      }

      const newBoard = applyMove(handoff.board, clientResult.position, 'O')
      const { status, winningLine } = checkWinner(newBoard)

      return {
        board: newBoard,
        boardDisplay: formatBoard(newBoard),
        status,
        userMove: clientResult.position,
        winningLine,
        hint:
          status === 'ongoing'
            ? 'Game continues. Make your next move.'
            : status === 'o_wins'
              ? 'User won! Call ttt_winner to announce.'
              : status === 'draw'
                ? "It's a draw! Call ttt_winner to announce."
                : 'You won! Call ttt_winner to announce.',
      }
    },
  })

/**
 * Announce the winner (fire-and-forget).
 */
export const tttWinner = createIsomorphicTool('ttt_winner')
  .description(
    'Announce the game result. Call this when the game ends (x_wins, o_wins, or draw). ' +
    'Displays a winner banner with the final board.'
  )
  .parameters(
    z.object({
      winner: z.enum(['X', 'O', 'draw']).describe('The winner (X, O) or draw'),
      board: z
        .array(z.union([z.literal('X'), z.literal('O'), z.null()]))
        .length(9)
        .describe('Final board state'),
      winningLine: z
        .array(z.number())
        .optional()
        .describe('Positions of the winning line (if not a draw)'),
    })
  )
  .context('browser')
  .authority('server')
  .approval({ client: 'none' })
  .handoff({
    *before(params) {
      return params
    },

    *client(handoff, ctx: any) {
      yield* ctx.render(WinnerBanner, {
        winner: handoff.winner,
        board: handoff.board as Board,
        winningLine: handoff.winningLine,
      })
      return undefined
    },

    *after(_handoff, _clientResult) {
      return 'Game complete. You can offer a rematch by starting a new game.'
    },
  })
