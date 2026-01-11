/**
 * GameMoveCard Component
 *
 * Displays a single move in the game as a chat-style message.
 * Shows a compact board state and move information.
 * Read-only - used for history display.
 */
import type { Board, Player } from '../../tictactoe/types'

// =============================================================================
// TYPES
// =============================================================================

export interface GameMoveCardProps {
  /** The board state after this move */
  board: Board
  /** The cell that was played */
  position: number
  /** Who made this move */
  player: Player
  /** Was this the model or user? */
  isModel: boolean
  /** Model's strategy (only for model moves) */
  strategy?: 'offensive' | 'defensive' | undefined
  /** Strategy reasoning */
  reasoning?: string | undefined
  /** Move number (1-indexed) */
  moveNumber: number
  /** Is this a winning move? */
  winningLine?: number[] | undefined
  /** Game result (only on final move) */
  gameResult?: 'win' | 'lose' | 'draw' | undefined
}

// =============================================================================
// MINI BOARD COMPONENT
// =============================================================================

function MiniBoard({ 
  board, 
  lastPosition, 
  winningLine 
}: { 
  board: Board
  lastPosition: number
  winningLine?: number[] | undefined
}) {
  return (
    <div className="grid grid-cols-3 gap-0.5 w-24 h-24">
      {board.map((cell, i) => {
        const isLastMove = i === lastPosition
        const isWinning = winningLine?.includes(i)
        
        let cellClass = 'w-8 h-8 flex items-center justify-center text-sm font-bold border border-slate-700 '
        
        if (isWinning) {
          cellClass += 'bg-emerald-900/60 '
        } else if (isLastMove) {
          cellClass += 'bg-cyan-900/40 ring-1 ring-cyan-500 '
        } else {
          cellClass += 'bg-slate-900/50 '
        }
        
        if (cell === 'X') {
          cellClass += 'text-cyan-400'
        } else if (cell === 'O') {
          cellClass += 'text-purple-400'
        } else {
          cellClass += 'text-slate-700'
        }
        
        return (
          <div key={i} className={cellClass}>
            {cell || '·'}
          </div>
        )
      })}
    </div>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function GameMoveCard({
  board,
  position,
  player,
  isModel,
  strategy,
  reasoning,
  moveNumber,
  winningLine,
  gameResult,
}: GameMoveCardProps) {
  const positionLabels = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
  
  // Determine styling based on who played
  const isUserMove = !isModel
  const borderColor = isUserMove ? 'border-purple-900/50' : 'border-cyan-900/50'
  const bgColor = isUserMove ? 'bg-purple-950/20' : 'bg-slate-800/30'
  const labelColor = isUserMove ? 'text-purple-400' : 'text-cyan-400'
  
  // Result styling
  const resultLabel = gameResult === 'win' 
    ? (isModel ? '🎉 Model wins!' : '🎉 You win!')
    : gameResult === 'lose'
      ? (isModel ? 'You win!' : 'Model wins!')
      : gameResult === 'draw'
        ? "🤝 It's a draw!"
        : null

  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} p-3 my-2`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold uppercase tracking-wider ${labelColor}`}>
            {isModel ? 'Model' : 'You'}
          </span>
          <span className="text-xs text-slate-500">
            Move #{moveNumber}
          </span>
        </div>
        {strategy && (
          <span className={`text-xs px-2 py-0.5 rounded ${
            strategy === 'offensive' 
              ? 'bg-amber-900/30 text-amber-400' 
              : 'bg-blue-900/30 text-blue-400'
          }`}>
            {strategy}
          </span>
        )}
      </div>
      
      {/* Content */}
      <div className="flex items-start gap-4">
        <MiniBoard board={board} lastPosition={position} winningLine={winningLine} />
        
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-300">
            <span className={player === 'X' ? 'text-cyan-400' : 'text-purple-400'}>
              {player}
            </span>
            {' '}played{' '}
            <span className="text-slate-100 font-medium">
              {positionLabels[position]} (cell {position})
            </span>
          </p>
          
          {reasoning && (
            <p className="text-xs text-slate-500 mt-1 italic line-clamp-2">
              "{reasoning}"
            </p>
          )}
          
          {resultLabel && (
            <p className="text-sm font-bold mt-2 text-emerald-400">
              {resultLabel}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

GameMoveCard.displayName = 'GameMoveCard'
