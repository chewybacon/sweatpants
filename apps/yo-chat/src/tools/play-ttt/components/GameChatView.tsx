/**
 * GameChatView Component
 *
 * Renders the tic-tac-toe game as a chat-style conversation.
 * Each move appears as a message, with the current state at the bottom.
 *
 * Features:
 * - Move history shown as read-only "message cards"
 * - Current board state shown at the bottom
 * - Interactive only when waiting for user input
 */
import type { RenderableProps } from '@sweatpants/framework/chat/isomorphic-tools'
import type { Board, Player } from '../../tictactoe/types'
import { GameMoveCard } from './GameMoveCard'

// =============================================================================
// TYPES
// =============================================================================

/** A single move in the game history */
export interface GameMove {
  /** The cell that was played */
  position: number
  /** Who made this move */
  player: Player
  /** Was this the model or user? */
  isModel: boolean
  /** Board state AFTER this move */
  boardAfter: Board
  /** Move number (1-indexed) */
  moveNumber: number
  /** Model's strategy (only for model moves) */
  strategy?: 'offensive' | 'defensive'
  /** Strategy reasoning */
  reasoning?: string
}

export interface GameChatViewProps extends RenderableProps<{ position: number }> {
  /** History of all moves so far */
  moveHistory: GameMove[]
  /** Current board state */
  board: Board
  /** User's symbol */
  userSymbol: Player
  /** Model's symbol */
  modelSymbol: Player
  /** The last move (for highlighting) */
  lastMove?: { position: number; player: Player }
  /** If game is over, the winning line */
  winningLine?: number[]
  /** Is the game over? */
  gameOver?: boolean
  /** Game result message */
  resultMessage?: string
}

// =============================================================================
// MINI BOARD FOR CURRENT STATE
// =============================================================================

function CurrentBoard({
  board,
  lastPosition,
  winningLine,
  gameOver,
  onRespond,
  disabled,
  response,
  userSymbol,
}: {
  board: Board
  lastPosition?: number | undefined
  winningLine?: number[] | undefined
  gameOver?: boolean | undefined
  onRespond?: ((value: { position: number }) => void) | undefined
  disabled?: boolean | undefined
  response?: { position: number } | undefined
  userSymbol: Player
}) {
  const renderCell = (position: number) => {
    const cell = board[position]
    const isWinningCell = winningLine?.includes(position)
    const isLastMove = position === lastPosition
    const isUserMove = response?.position === position

    // Determine cell styling
    let cellStyle = 'w-14 h-14 text-xl font-bold border border-slate-600 '

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
        onClick={() => onRespond?.({ position })}
        className={cellStyle + 'hover:bg-slate-700 cursor-pointer transition-colors flex items-center justify-center text-slate-600'}
      >
        {position}
      </button>
    )
  }

  return (
    <div className="grid grid-cols-3 gap-1">
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(renderCell)}
    </div>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function GameChatView({
  moveHistory,
  board,
  userSymbol,
  modelSymbol,
  lastMove,
  winningLine,
  gameOver,
  resultMessage,
  onRespond,
  disabled,
  response,
}: GameChatViewProps) {
  // Determine game result for the last move card
  const getGameResult = (move: GameMove): 'win' | 'lose' | 'draw' | undefined => {
    if (!gameOver || move.moveNumber !== moveHistory.length) return undefined
    if (winningLine && winningLine.length > 0) {
      return move.isModel ? 'win' : 'lose'
    }
    return 'draw'
  }

  return (
    <div className="space-y-2 my-3">
      {/* Move History */}
      {moveHistory.map((move, index) => (
        <GameMoveCard
          key={`move-${move.moveNumber}`}
          board={move.boardAfter}
          position={move.position}
          player={move.player}
          isModel={move.isModel}
          strategy={move.strategy}
          reasoning={move.reasoning}
          moveNumber={move.moveNumber}
          winningLine={index === moveHistory.length - 1 ? winningLine : undefined}
          gameResult={getGameResult(move)}
        />
      ))}

      {/* Current State / Input */}
      {!gameOver ? (
        <div className="rounded-lg border border-purple-900/50 bg-purple-950/20 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-purple-400">
                Your Turn
              </span>
              <span className="text-xs text-slate-500">
                Playing as {userSymbol}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-4">
            <CurrentBoard
              board={board}
              lastPosition={lastMove?.position}
              onRespond={onRespond}
              disabled={disabled}
              response={response}
              userSymbol={userSymbol}
            />

            <div className="flex-1 min-w-0">
              {!disabled && !response && (
                <p className="text-sm text-slate-400">
                  Click a cell to make your move
                </p>
              )}
              {response && (
                <p className="text-sm text-slate-400">
                  You selected cell {response.position}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Game Over State */
        <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-4 text-center">
          <div className="text-xl font-bold text-emerald-400 mb-2">
            {resultMessage || 'Game Over'}
          </div>
          <CurrentBoard
            board={board}
            lastPosition={lastMove?.position}
            winningLine={winningLine}
            gameOver={true}
            disabled={true}
            userSymbol={userSymbol}
          />
        </div>
      )}
    </div>
  )
}

GameChatView.displayName = 'GameChatView'
