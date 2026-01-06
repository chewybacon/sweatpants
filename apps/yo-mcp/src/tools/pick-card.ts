/**
 * Pick Card Tool
 *
 * A simple MCP tool that demonstrates elicitation.
 * The server draws random cards, and the user picks one.
 */
import { z } from 'zod'
import { createMCPTool } from '@sweatpants/framework/chat/mcp-tools'

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

type Card = { rank: (typeof RANKS)[number]; suit: (typeof SUITS)[number] }

function drawCards(count: number): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit })
    }
  }

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = deck[i]!
    deck[i] = deck[j]!
    deck[j] = temp
  }

  return deck.slice(0, count)
}

function formatCard(card: Card): string {
  const suitEmoji = {
    hearts: 'hearts',
    diamonds: 'diamonds',
    clubs: 'clubs',
    spades: 'spades',
  }
  return `${card.rank} of ${suitEmoji[card.suit]}`
}

export const pickCardTool = createMCPTool('pick_card')
  .description('Draw random cards and let the user pick one')
  .parameters(
    z.object({
      count: z.number().min(2).max(10).default(5).describe('Number of cards to draw'),
    })
  )
  .requires({ elicitation: true })
  .handoff({
    *before(params) {
      // Draw random cards (non-idempotent - runs once)
      const cards = drawCards(params.count)
      // Secret is always defined since count >= 2 (enforced by schema)
      const secret = cards[Math.floor(Math.random() * cards.length)]!

      return {
        cards,
        secret,
        drawnAt: new Date().toISOString(),
      }
    },

    *client(handoff, ctx) {
      yield* ctx.log('info', `Drew ${handoff.cards.length} cards`)

      // Format cards for display
      const cardOptions = handoff.cards
        .map((card, i) => `${i + 1}. ${formatCard(card)}`)
        .join('\n')

      // Ask user to pick
      const result = yield* ctx.elicit({
        message: `I've drawn ${handoff.cards.length} cards. Pick one!\n\n${cardOptions}`,
        schema: z.object({
          cardNumber: z
            .number()
            .min(1)
            .max(handoff.cards.length)
            .describe('Card number (1-based)'),
        }),
      })

      if (result.action !== 'accept') {
        return { picked: null, cancelled: true }
      }

      const pickedIndex = result.content.cardNumber - 1
      // pickedCard is always defined since cardNumber is validated to be in range
      const pickedCard = handoff.cards[pickedIndex]!

      return {
        picked: pickedCard,
        cancelled: false,
      }
    },

    *after(handoff, client) {
      if (client.cancelled || !client.picked) {
        return {
          success: false,
          message: 'No card was picked.',
        }
      }

      const isWinner =
        client.picked.rank === handoff.secret.rank && client.picked.suit === handoff.secret.suit

      return {
        success: true,
        picked: formatCard(client.picked),
        secret: formatCard(handoff.secret),
        isWinner,
        message: isWinner
          ? `You picked the secret card! ${formatCard(client.picked)}`
          : `You picked ${formatCard(client.picked)}, but the secret was ${formatCard(handoff.secret)}.`,
      }
    },
  })
