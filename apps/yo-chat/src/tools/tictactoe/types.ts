/**
 * TicTacToe Types
 *
 * Shared types for the TicTacToe plugin.
 */

export type Cell = 'X' | 'O' | null
export type Board = [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell]
export type GameStatus = 'ongoing' | 'x_wins' | 'o_wins' | 'draw'
export type Player = 'X' | 'O'

export interface LastMove {
  position: number
  player: Player
}

export interface GameState {
  board: Board
  status: GameStatus
  lastMove?: LastMove
  winningLine?: number[]
}

// =============================================================================
// GAME LOGIC
// =============================================================================

export const EMPTY_BOARD: Board = [null, null, null, null, null, null, null, null, null]

export const WINNING_LINES = [
  [0, 1, 2], // rows
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6], // columns
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8], // diagonals
  [2, 4, 6],
]

export function checkWinner(board: Board): { status: GameStatus; winningLine?: number[] } {
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

export function applyMove(board: Board, position: number, player: Player): Board {
  if (board[position] !== null) {
    throw new Error(`Position ${position} is already occupied`)
  }
  const newBoard = [...board] as Board
  newBoard[position] = player
  return newBoard
}

export function formatBoard(board: Board): string {
  const symbols = board.map((cell, i) => (cell === null ? String(i) : cell))
  return [
    `${symbols[0]} | ${symbols[1]} | ${symbols[2]}`,
    '---------',
    `${symbols[3]} | ${symbols[4]} | ${symbols[5]}`,
    '---------',
    `${symbols[6]} | ${symbols[7]} | ${symbols[8]}`,
  ].join('\n')
}
