import { z } from 'zod'

import { createIsomorphicTool } from './builder'

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const

type Suit = (typeof SUITS)[number]
type Rank = (typeof RANKS)[number]

interface Card {
  suit: Suit
  rank: Rank
}

// Server-side deck state (in-memory, resets on server restart).
// In production, this would be stored in a database with session IDs.
let serverDeck: Card[] = []
let serverDiscardPile: Card[] = []

function createFreshDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank })
    }
  }
  return deck
}

function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
      // Deck indices are guaranteed here; assert non-null for exactOptionalPropertyTypes
      ;[shuffled[i]!, shuffled[j]!] = [shuffled[j]!, shuffled[i]!]
  }
  return shuffled
}

export const drawCardIsomorphicTool = createIsomorphicTool('draw_card')
  .description(
    'Draw a card from the deck. The server maintains the deck state to prevent cheating. Returns the drawn card which should then be displayed to the user via the display_card client tool.'
  )
  .parameters(
    z.object({
      count: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .describe('Number of cards to draw (1-5, default 1)'),
    })
  )
  .authority('server')
  .server(function* ({ count = 1 }) {
    if (serverDeck.length === 0) {
      serverDeck = shuffleDeck(createFreshDeck())
      serverDiscardPile = []
    }

    if (serverDeck.length < count) {
      serverDeck = shuffleDeck([...serverDeck, ...serverDiscardPile])
      serverDiscardPile = []
    }

    const drawnCards = serverDeck.splice(0, count)

    return {
      cards: drawnCards,
      remainingInDeck: serverDeck.length,
      message: `Drew ${drawnCards.length} card(s). Use the display_card tool to show ${drawnCards.length > 1 ? 'them' : 'it'} to the user.`,
    }
  })
  .build()

export const shuffleDeckIsomorphicTool = createIsomorphicTool('shuffle_deck')
  .description('Shuffle and reset the deck to a fresh 52 cards. Use this to start a new game.')
  .parameters(z.object({}))
  .authority('server')
  .server(function* () {
    serverDeck = shuffleDeck(createFreshDeck())
    serverDiscardPile = []
    return {
      message: 'Deck shuffled! 52 cards ready.',
      remainingInDeck: serverDeck.length,
    }
  })
  .build()

export const deckStatusIsomorphicTool = createIsomorphicTool('deck_status')
  .description('Check how many cards remain in the deck.')
  .parameters(z.object({}))
  .authority('server')
  .server(function* () {
    return {
      remainingInDeck: serverDeck.length,
      inDiscardPile: serverDiscardPile.length,
    }
  })
  .build()

export const cardGameIsomorphicTools = [
  drawCardIsomorphicTool,
  shuffleDeckIsomorphicTool,
  deckStatusIsomorphicTool,
] as const
