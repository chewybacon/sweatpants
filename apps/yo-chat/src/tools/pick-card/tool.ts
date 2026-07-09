import { createTool } from '@sweatpants/core'
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

export const CardSchema = z.object({
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
    return [
      `Card selection recorded: the user picked ${card.rank} of ${card.suit} (${card.display}).`,
      'Remember this selected card for later questions in the same conversation.',
      'Acknowledge the specific selected card to the user now.',
    ].join(' ')
  })
