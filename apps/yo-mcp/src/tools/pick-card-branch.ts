/**
 * Pick Card Tool (Branch Version)
 *
 * A simple MCP tool that demonstrates branch-based execution.
 * The server draws random cards, asks the LLM for analysis,
 * and then the user picks one.
 */
import { z } from 'zod'
import { createMcpTool } from '@sweatpants/framework/chat/mcp-tools'

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

// Define the elicitation schema
const pickCardSchema = z.object({
  cardNumber: z.number().min(1).describe('Card number (1-based)'),
})

export const pickCardBranchTool = createMcpTool('pick_card_branch')
  .description('Draw random cards with LLM analysis and user pick (branch version)')
  .parameters(
    z.object({
      count: z.number().min(2).max(10).default(5).describe('Number of cards to draw'),
      analyze: z.boolean().default(false).describe('Whether to analyze the cards with LLM'),
    })
  )
  .elicits({
    pickCard: {
      response: pickCardSchema,
    },
  })
  .handoff({
    *before(params) {
      // Draw random cards (non-idempotent - runs once)
      const cards = drawCards(params.count)
      // Secret is always defined since count >= 2 (enforced by schema)
      const secret = cards[Math.floor(Math.random() * cards.length)]!

      return {
        cards,
        secret,
        analyze: params.analyze,
        drawnAt: new Date().toISOString(),
      }
    },

    *client(handoff, ctx) {
      yield* ctx.log('info', `Drew ${handoff.cards.length} cards`)

      // Format cards for display
      const cardList = handoff.cards.map((card, i) => `${i + 1}. ${formatCard(card)}`).join('\n')

      // Optional: Get LLM analysis of the cards
      let analysis: string | undefined

      if (handoff.analyze) {
        yield* ctx.notify('Analyzing cards...', 0.3)

        // Use sub-branch for isolated analysis conversation
        analysis = yield* ctx.branch(
          function* (subCtx) {
            const result = yield* subCtx.sample({
              prompt: `You are a card game expert. Here are the cards drawn:
${cardList}

Briefly analyze these cards (2-3 sentences). What patterns or interesting cards do you see? Keep it fun and casual.`,
            })

            return result.text
          },
          {
            inheritMessages: false, // Fresh context for analysis
            maxDepth: 1, // Don't allow further nesting
          }
        )

        yield* ctx.notify('Analysis complete', 0.6)
      }

      // Ask user to pick
      const prompt = analysis
        ? `I've drawn ${handoff.cards.length} cards.\n\n**Analysis:** ${analysis}\n\n**Cards:**\n${cardList}\n\nPick one!`
        : `I've drawn ${handoff.cards.length} cards. Pick one!\n\n${cardList}`

      const result = yield* ctx.elicit('pickCard', { message: prompt })

      if (result.action !== 'accept') {
        return { picked: null, cancelled: true, analysis }
      }

      const pickedIndex = result.content.cardNumber - 1
      // pickedCard is always defined since cardNumber is validated to be in range
      const pickedCard = handoff.cards[pickedIndex]!

      return {
        picked: pickedCard,
        cancelled: false,
        analysis,
      }
    },

    *after(handoff, client) {
      if (client.cancelled || !client.picked) {
        return {
          success: false,
          message: 'No card was picked.',
          analysis: client.analysis,
        }
      }

      const isWinner =
        client.picked.rank === handoff.secret.rank && client.picked.suit === handoff.secret.suit

      return {
        success: true,
        picked: formatCard(client.picked),
        secret: formatCard(handoff.secret),
        isWinner,
        analysis: client.analysis,
        message: isWinner
          ? `You picked the secret card! ${formatCard(client.picked)}`
          : `You picked ${formatCard(client.picked)}, but the secret was ${formatCard(handoff.secret)}.`,
      }
    },
  })
