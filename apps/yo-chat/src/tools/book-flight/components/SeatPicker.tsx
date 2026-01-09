/**
 * SeatPicker Component
 *
 * Displays an airplane-style seat map for the user to select their seat.
 * Used by the book_flight tool's pickSeat elicitation.
 */
import { useState } from 'react'
import type { RenderableProps } from '@sweatpants/framework/chat/isomorphic-tools'
import type { SeatMap } from '../tool'

// =============================================================================
// TYPES
// =============================================================================

interface SeatPickerProps extends RenderableProps<{ row: number; seat: string }> {
  seatMap: SeatMap
  message: string
  flightInfo?: {
    airline: string
    flightNumber: string
  }
}

// =============================================================================
// SEAT COMPONENT
// =============================================================================

interface SeatProps {
  row: number
  seat: string
  status: 'available' | 'taken' | 'selected'
  onSelect: () => void
  disabled: boolean
}

function Seat({ row, seat, status, onSelect, disabled }: SeatProps) {
  const baseClasses = 'w-8 h-8 rounded-t-lg text-xs font-medium flex items-center justify-center transition-all'

  const statusClasses = {
    available: 'bg-muted-foreground/20 hover:bg-primary/30 cursor-pointer',
    taken: 'bg-muted-foreground/50 cursor-not-allowed',
    selected: 'bg-primary text-primary-foreground',
  }

  return (
    <button
      onClick={onSelect}
      disabled={disabled || status === 'taken'}
      title={status === 'taken' ? 'Seat taken' : `Seat ${row}${seat}`}
      className={`${baseClasses} ${statusClasses[status]} ${disabled ? 'opacity-60' : ''}`}
    >
      {status === 'taken' ? 'X' : seat}
    </button>
  )
}

// =============================================================================
// AIRPLANE ICON
// =============================================================================

function AirplaneNoseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 40" fill="currentColor">
      <path d="M0 20 Q50 0 100 20 Q50 40 0 20" />
    </svg>
  )
}

// =============================================================================
// SEAT PICKER COMPONENT
// =============================================================================

export function SeatPicker({ seatMap, message, flightInfo, onRespond, disabled, response }: SeatPickerProps) {
  const [selectedSeat, setSelectedSeat] = useState<{ row: number; seat: string } | null>(null)

  const handleSeatClick = (row: number, seat: string) => {
    if (disabled) return
    setSelectedSeat({ row, seat })
  }

  const handleConfirm = () => {
    if (selectedSeat) {
      onRespond(selectedSeat)
    }
  }

  const getSeatStatus = (row: number, seat: string): 'available' | 'taken' | 'selected' => {
    const seatCode = `${row}${seat}`
    if (response && response.row === row && response.seat === seat) return 'selected'
    if (selectedSeat?.row === row && selectedSeat?.seat === seat) return 'selected'
    if (seatMap.taken.includes(seatCode)) return 'taken'
    return 'available'
  }

  // Calculate aisle position (typically between C and D for 6-seat rows)
  const aisleAfterIndex = Math.floor(seatMap.seatsPerRow.length / 2)

  // If already responded, show the selection
  if (disabled && response) {
    return (
      <div className="my-3 p-4 bg-muted rounded-lg">
        <div className="mb-3">
          <p className="text-sm font-medium">{message}</p>
          {flightInfo && (
            <p className="text-xs text-muted-foreground">
              {flightInfo.airline} {flightInfo.flightNumber}
            </p>
          )}
        </div>

        <div className="flex flex-col items-center">
          {/* Airplane nose */}
          <div className="w-full max-w-xs">
            <AirplaneNoseIcon className="w-full h-8 text-muted-foreground/30" />
          </div>

          {/* Seat grid */}
          <div className="bg-muted-foreground/10 rounded-b-3xl p-4 w-full max-w-xs">
            {Array.from({ length: seatMap.rows }, (_, rowIdx) => {
              const row = rowIdx + 1
              return (
                <div key={row} className="flex items-center justify-center gap-1 mb-1">
                  <span className="w-4 text-xs text-muted-foreground text-right mr-2">{row}</span>
                  {seatMap.seatsPerRow.map((seat, seatIdx) => (
                    <div key={seat} className="flex">
                      <div
                        className={`
                          w-6 h-6 rounded-t text-[10px] flex items-center justify-center
                          ${response.row === row && response.seat === seat
                            ? 'bg-primary text-primary-foreground'
                            : seatMap.taken.includes(`${row}${seat}`)
                              ? 'bg-muted-foreground/40'
                              : 'bg-muted-foreground/20'
                          }
                        `}
                      >
                        {seatMap.taken.includes(`${row}${seat}`) ? 'X' : seat}
                      </div>
                      {seatIdx === aisleAfterIndex - 1 && <div className="w-4" />}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-3 text-center">
          Selected: Seat {response.row}{response.seat}
        </p>
      </div>
    )
  }

  // Interactive state
  return (
    <div className="my-3 p-4 bg-muted rounded-lg">
      <div className="mb-3">
        <p className="text-sm font-medium">{message}</p>
        {flightInfo && (
          <p className="text-xs text-muted-foreground">
            {flightInfo.airline} {flightInfo.flightNumber}
          </p>
        )}
      </div>

      <div className="flex flex-col items-center">
        {/* Airplane nose */}
        <div className="w-full max-w-xs">
          <AirplaneNoseIcon className="w-full h-8 text-muted-foreground/30" />
        </div>

        {/* Seat grid */}
        <div className="bg-muted-foreground/10 rounded-b-3xl p-4 w-full max-w-xs">
          {/* Header row with seat letters */}
          <div className="flex items-center justify-center gap-1 mb-2">
            <span className="w-4 mr-2" />
            {seatMap.seatsPerRow.map((seat, seatIdx) => (
              <div key={seat} className="flex">
                <span className="w-8 text-center text-xs text-muted-foreground font-medium">
                  {seat}
                </span>
                {seatIdx === aisleAfterIndex - 1 && <div className="w-4" />}
              </div>
            ))}
          </div>

          {/* Seat rows */}
          {Array.from({ length: seatMap.rows }, (_, rowIdx) => {
            const row = rowIdx + 1
            return (
              <div key={row} className="flex items-center justify-center gap-1 mb-1">
                <span className="w-4 text-xs text-muted-foreground text-right mr-2">{row}</span>
                {seatMap.seatsPerRow.map((seat, seatIdx) => (
                  <div key={seat} className="flex">
                    <Seat
                      row={row}
                      seat={seat}
                      status={getSeatStatus(row, seat)}
                      onSelect={() => handleSeatClick(row, seat)}
                      disabled={disabled ?? false}
                    />
                    {seatIdx === aisleAfterIndex - 1 && <div className="w-4" />}
                  </div>
                ))}
              </div>
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-muted-foreground/20" />
            <span>Available</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-muted-foreground/50" />
            <span>Taken</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-primary" />
            <span>Selected</span>
          </div>
        </div>

        {/* Confirm button */}
        {selectedSeat && (
          <button
            onClick={handleConfirm}
            disabled={disabled}
            className="mt-4 px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            Confirm Seat {selectedSeat.row}{selectedSeat.seat}
          </button>
        )}
      </div>
    </div>
  )
}

SeatPicker.displayName = 'SeatPicker'
