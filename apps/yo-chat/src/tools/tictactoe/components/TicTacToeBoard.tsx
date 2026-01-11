/**
 * TicTacToe Board Component
 *
 * Interactive board for the tictactoe plugin.
 * Displays the game state and handles cell clicks.
 */
import type { RenderableProps } from '@sweatpants/framework/chat/isomorphic-tools'
import type { Board, LastMove } from '../types'

// =============================================================================
// TYPES
// =============================================================================

interface TicTacToeBoardProps extends RenderableProps<{ position: number }> {
  board: Board
  lastMove?: LastMove
  winningLine?: number[]
  gameOver?: boolean
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TicTacToeBoard({
  board,
  lastMove,
  winningLine,
  gameOver,
  onRespond,
  disabled,
  response,
}: TicTacToeBoardProps) {
  const renderCell = (position: number) => {
    const cell = board[position]
    const isWinningCell = winningLine?.includes(position)
    const isLastMove = lastMove?.position === position
    const isUserMove = response?.position === position

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
    if (disabled || gameOver || cell !== null) {
      return (
        <div key={position} className={cellStyle + 'flex items-center justify-center'}>
          {cell || ''}
        </div>
      )
    }

    return (
      <button
        key={position}
        onClick={() => onRespond({ position })}
        className={cellStyle + 'hover:bg-slate-700 cursor-pointer transition-colors flex items-center justify-center text-slate-600'}
      >
        {position}
      </button>
    )
  }

  // Game over state
  if (gameOver) {
    const winner = winningLine && winningLine.length > 0 ? (board[winningLine[0]!] as 'X' | 'O') : null
    const message = winner
      ? winner === 'X'
        ? 'X wins!'
        : 'O wins!'
      : "It's a draw!"

    const subtext = winner === 'X'
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
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(renderCell)}
          </div>
        </div>
      </div>
    )
  }

  // Active game state
  return (
    <div className="my-3 p-4 bg-slate-800/50 rounded-lg inline-block">
      <div className="grid grid-cols-3 gap-1">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(renderCell)}
      </div>
      {!disabled && (
        <p className="text-xs text-slate-500 mt-2">Click a cell to make your move</p>
      )}
      {disabled && response && (
        <p className="text-xs text-slate-500 mt-2">You played position {response.position}</p>
      )}
    </div>
  )
}

TicTacToeBoard.displayName = 'TicTacToeBoard'
