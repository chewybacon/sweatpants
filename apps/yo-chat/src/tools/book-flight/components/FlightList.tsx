/**
 * FlightList Component
 *
 * Displays a list of available flights for the user to select.
 * Used by the book_flight tool's pickFlight elicitation.
 */
import { useMemo } from 'react'
import type { RenderableProps } from '@sweatpants/framework/chat/isomorphic-tools'
import { stripMessageContext } from '@sweatpants/framework/chat'
import type { Flight } from '../tool'

// =============================================================================
// TYPES
// =============================================================================

interface FlightListProps extends RenderableProps<{ flightId: string }> {
  flights: Flight[]
  message: string
}

// =============================================================================
// AIRPLANE ICON
// =============================================================================

function AirplaneIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  )
}

// =============================================================================
// FLIGHT CARD
// =============================================================================

interface FlightCardProps {
  flight: Flight
  selected: boolean
  onSelect: () => void
  disabled: boolean
}

function FlightCard({ flight, selected, onSelect, disabled }: FlightCardProps) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`
        w-full p-4 rounded-lg border-2 transition-all text-left
        ${selected
          ? 'border-primary bg-primary/10'
          : 'border-muted hover:border-primary/50 hover:bg-muted/50'
        }
        ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}
      `}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <AirplaneIcon className="w-5 h-5 text-primary" />
          <span className="font-semibold">{flight.airline}</span>
        </div>
        <span className="text-sm text-muted-foreground">{flight.flightNumber}</span>
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="text-center">
          <div className="text-lg font-bold">{flight.departure}</div>
          <div className="text-xs text-muted-foreground">Depart</div>
        </div>

        <div className="flex-1 mx-4 flex items-center">
          <div className="flex-1 border-t border-dashed border-muted-foreground/40" />
          <div className="px-2 text-xs text-muted-foreground">{flight.duration}</div>
          <div className="flex-1 border-t border-dashed border-muted-foreground/40" />
        </div>

        <div className="text-center">
          <div className="text-lg font-bold">{flight.arrival}</div>
          <div className="text-xs text-muted-foreground">Arrive</div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-2xl font-bold text-primary">${flight.price}</span>
        {selected && (
          <span className="text-sm text-primary font-medium">Selected</span>
        )}
      </div>
    </button>
  )
}

// =============================================================================
// FLIGHT LIST COMPONENT
// =============================================================================

export function FlightList({ flights, message, onRespond, disabled, response }: FlightListProps) {
  // Strip any x-model-context boundary from the message
  const cleanMessage = useMemo(() => stripMessageContext(message), [message])

  // If already responded, show the selection
  if (disabled && response) {
    const selectedFlight = flights.find(f => f.id === response.flightId)
    return (
      <div className="my-3 p-4 bg-muted rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <AirplaneIcon className="w-5 h-5 text-primary" />
          <p className="text-sm font-medium">{cleanMessage}</p>
        </div>
        <div className="space-y-2">
          {flights.map((flight) => (
            <div
              key={flight.id}
              className={`
                p-3 rounded-lg border
                ${flight.id === response.flightId
                  ? 'border-primary bg-primary/10'
                  : 'border-muted-foreground/20 opacity-50'
                }
              `}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{flight.airline}</span>
                  <span className="text-sm text-muted-foreground">{flight.flightNumber}</span>
                </div>
                <span className="font-bold">${flight.price}</span>
              </div>
              <div className="text-sm text-muted-foreground">
                {flight.departure} - {flight.arrival} ({flight.duration})
              </div>
            </div>
          ))}
        </div>
        {selectedFlight && (
          <p className="text-xs text-muted-foreground mt-2">
            Selected: {selectedFlight.airline} {selectedFlight.flightNumber}
          </p>
        )}
      </div>
    )
  }

  // Interactive state
  return (
    <div className="my-3 p-4 bg-muted rounded-lg">
      <div className="flex items-center gap-2 mb-4">
        <AirplaneIcon className="w-5 h-5 text-primary" />
        <p className="text-sm font-medium">{cleanMessage}</p>
      </div>
      <div className="space-y-3">
        {flights.map((flight) => (
          <FlightCard
            key={flight.id}
            flight={flight}
            selected={false}
            onSelect={() => onRespond({ flightId: flight.id })}
            disabled={disabled ?? false}
          />
        ))}
      </div>
    </div>
  )
}

FlightList.displayName = 'FlightList'
