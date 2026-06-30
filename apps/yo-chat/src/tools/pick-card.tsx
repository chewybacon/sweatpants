import { createTool } from '@sweatpants/core'
import { getElicitContext, makePlugin, stripMessageContext } from '@sweatpants/framework/chat'
import type { RenderableProps } from '@sweatpants/framework/chat/browser-rendering'
import { z } from 'zod'

const CARDS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']
const SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades']
const SUIT_SYMBOLS: Record<string, string> = {
  Hearts: '\u2665',
  Diamonds: '\u2666',
  Clubs: '\u2663',
  Spades: '\u2660',
}

export interface Card {
  rank: string
  suit: string
  display: string
}

const CardSchema = z.object({
  rank: z.string(),
  suit: z.string(),
  display: z.string(),
})

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

interface CardPickerProps extends RenderableProps<{ picked: Card }> {
  cards: Card[]
  prompt: string
}

function CardPicker({ cards, prompt, onRespond, disabled, response }: CardPickerProps) {
  if (disabled && response) {
    return (
      <div className="my-2 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground mb-2">{prompt}</p>
        <div className="flex gap-2 flex-wrap">
          {cards.map((card) => (
            <button
              type="button"
              key={`${card.rank}-${card.suit}`}
              disabled
              className={`
                px-3 py-2 rounded border text-lg font-mono
                ${card.display === response.picked.display
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-muted-foreground/20 text-muted-foreground/50'
                }
              `}
            >
              {card.display}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          You picked: {response.picked.display}
        </p>
      </div>
    )
  }

  return (
    <div className="my-2 p-3 bg-muted rounded-lg">
      <p className="text-sm text-muted-foreground mb-2">{prompt}</p>
      <div className="flex gap-2 flex-wrap">
        {cards.map((card) => (
          <button
            type="button"
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

CardPicker.displayName = 'CardPicker'

function* replayPickCardTrace(trace: {
  emissions: Array<{
    order: number
    componentKey: string
    props: Record<string, unknown>
    response?: unknown
    timestamp: number
  }>
  startedAt: number
  completedAt: number
}) {
  return {
    ...trace,
    emissions: trace.emissions.map((entry) => ({
      ...entry,
      _component: CardPicker,
    })),
  }
}

type PickCardContext = {
  cards: Card[]
  prompt: string
  [key: string]: unknown
}

export const pickCard = createTool('pick_card')
  .description('Draw random cards and let the user pick one')
  .parameters(
    z.object({
      count: z.number().min(2).max(10).default(5).describe('Number of cards to draw'),
    })
  )
  .elicits({
    pickCard: {
      context: z.object({
        cards: z.array(CardSchema),
        prompt: z.string(),
      }),
      response: z.object({
        picked: CardSchema,
      }),
    },
  })
  .execute(function* (params, ctx) {
    const cards = drawUniqueCards(params.count)
    const prompt = `Pick one of these ${cards.length} cards:`
    const picked = yield* ctx.elicit('pickCard', {
      message: prompt,
      context: { cards, prompt },
    })

    if (picked.action !== 'accept') {
      return 'No card was selected.'
    }

    const card = picked.content.picked
    return `The user selected the ${card.rank} of ${card.suit}. Please acknowledge their choice.`
  })

export const pickCardPlugin = makePlugin(pickCard)
  .onElicit({
    pickCard: function* (req, ctx) {
      const context = getElicitContext<PickCardContext>(req)
      const cards = context.cards ?? []
      const prompt = context.prompt ?? stripMessageContext(req.message)
      const result = yield* ctx.render(CardPicker, { cards, prompt })
      return { action: 'accept' as const, content: result }
    },
  })
  .build()

;(pickCard as typeof pickCard & { replayTrace?: typeof replayPickCardTrace }).replayTrace = replayPickCardTrace
