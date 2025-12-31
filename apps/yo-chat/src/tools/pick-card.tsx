/**
 * Pick Card Tool
 *
 * A demonstration of the ctx.render() pattern for interactive tools.
 * Server draws cards, client lets user pick one via rendered UI.
 */
import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import type { RenderableProps } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'

// =============================================================================
// CARD UTILITIES
// =============================================================================

const CARDS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']
const SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades']
const SUIT_SYMBOLS: Record<string, string> = {
  'Hearts': '\u2665',
  'Diamonds': '\u2666',
  'Clubs': '\u2663',
  'Spades': '\u2660',
}

export interface Card {
  rank: string
  suit: string
  display: string
}

function drawRandomCard(): Card {
  const rank = CARDS[Math.floor(Math.random() * CARDS.length)]!
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)]!
  return {
    rank,
    suit,
    display: `${rank}${SUIT_SYMBOLS[suit]}`,
  }
}

function drawUniqueCards(count: number): Card[] {
  const cards = new Map<string, Card>()
  while (cards.size < count && cards.size < CARDS.length * SUITS.length) {
    const card = drawRandomCard()
    const key = `${card.rank}-${card.suit}`
    if (!cards.has(key)) {
      cards.set(key, card)
    }
  }
  return [...cards.values()]
}

// =============================================================================
// CARD PICKER COMPONENT
// =============================================================================

interface CardPickerProps extends RenderableProps<{ picked: Card }> {
  cards: Card[]
  prompt: string
}

/**
 * Card picker component rendered inline in the chat.
 */
function CardPicker({ cards, prompt, onRespond, disabled, response }: CardPickerProps) {
  // If already responded, show the selection
  if (disabled && response) {
    return (
      <div className="my-2 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground mb-2">{prompt}</p>
        <div className="flex gap-2 flex-wrap">
          {cards.map((card) => (
            <div
              key={`${card.rank}-${card.suit}`}
              className={`
                px-3 py-2 rounded border text-lg font-mono
                ${card.display === response.picked.display
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-muted-foreground/20 text-muted-foreground/50'
                }
              `}
            >
              {card.display}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          You picked: {response.picked.display}
        </p>
      </div>
    )
  }

  // Interactive state
  return (
    <div className="my-2 p-3 bg-muted rounded-lg">
      <p className="text-sm text-muted-foreground mb-2">{prompt}</p>
      <div className="flex gap-2 flex-wrap">
        {cards.map((card) => (
          <button
            key={`${card.rank}-${card.suit}`}
            onClick={() => onRespond({ picked: card })}
            disabled={disabled}
            className={`
              px-3 py-2 rounded border text-lg font-mono
              transition-colors
              ${disabled
                ? 'cursor-not-allowed opacity-50'
                : 'hover:border-primary hover:bg-primary/10 cursor-pointer'
              }
              border-muted-foreground/40
            `}
          >
            {card.display}
          </button>
        ))}
      </div>
    </div>
  )
}

// Ensure the component has a display name for serialization
CardPicker.displayName = 'CardPicker'

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const pickCard = createIsomorphicTool('pick_card')
  .description('Draw random cards and let the user pick one')
  .parameters(
    z.object({
      count: z.number().min(2).max(10).default(5).describe('Number of cards to draw'),
    })
  )
  .context('browser')
  .authority('server')
  .approval({ client: 'none' }) // Skip approval for demo - the card picker IS the user interaction
  .handoff({
    /**
     * Server draws random cards.
     */
    *before(params) {
      const cards = drawUniqueCards(params.count)
      return {
        cards,
        prompt: `Pick one of these ${cards.length} cards:`,
      }
    },

    /**
     * Client renders the card picker and waits for selection.
     */
    *client(handoff, ctx: any) {
      const result = yield* ctx.render(CardPicker, {
        cards: handoff.cards,
        prompt: handoff.prompt,
      })
      return result
    },

    /**
     * Server confirms the selection.
     */
    *after(handoff, client: { picked: Card }) {
      // Return a clear string message for the LLM
      return `The user selected the ${client.picked.rank} of ${client.picked.suit}. Please acknowledge their choice.`
    },
  })
