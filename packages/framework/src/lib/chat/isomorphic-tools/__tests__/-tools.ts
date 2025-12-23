/**
 * Magic Trick Isomorphic Tools
 *
 * A toolkit for the LLM to perform interactive magic tricks and guessing games.
 * Demonstrates isomorphic tools with proper client/server separation.
 *
 * ## Authority Modes:
 *
 * SERVER AUTHORITY (server first, client presents):
 * - pick_secret: Server picks a secret, client shows thinking animation
 * - give_hint: Server generates hint, client displays it
 * - reveal_answer: Server reveals truth, client shows dramatic animation
 * - celebrate: Server determines celebration, client shows effects
 *
 * CLIENT AUTHORITY (client collects input, server validates):
 * - get_user_guess: Client shows options and collects guess, server validates
 * - ask_yes_no: Client asks user question, server processes answer
 *
 * ## Key Protocol:
 * - Client code CANNOT access game state (it's server-side only)
 * - For client-authority tools, server generates any data needed (like choices)
 *   and passes it via the tool parameters or a handoff mechanism
 * - Server's return value is what the LLM sees
 */
import { z } from 'zod'
import { call } from 'effection'
import { defineIsomorphicTool } from '../index'

// --- Types ---

export interface Card {
  suit: 'hearts' | 'diamonds' | 'clubs' | 'spades'
  rank: string
}

export interface GameState {
  secretCard: Card | null
  secretNumber: number | null
  secretWord: string | null
  guessCount: number
  lastHint: string | null
  // For client-authority tools: pre-generated choices
  pendingChoices: string[] | null
}

// --- Session-based Game State Store ---

const gameSessions = new Map<string, GameState>()
const DEFAULT_SESSION = 'default'

function getSession(sessionId: string): GameState {
  let state = gameSessions.get(sessionId)
  if (!state) {
    state = createInitialState()
    gameSessions.set(sessionId, state)
  }
  return state
}

function createInitialState(): GameState {
  return {
    secretCard: null,
    secretNumber: null,
    secretWord: null,
    guessCount: 0,
    lastHint: null,
    pendingChoices: null,
  }
}

function resetSession(sessionId: string): GameState {
  const state = createInitialState()
  gameSessions.set(sessionId, state)
  return state
}

// --- Client-Side Callback Registry ---

export interface MagicTrickCallbacks {
  onThinking?: (message: string) => void
  onShowHint?: (hint: string, style: 'mystical' | 'playful' | 'dramatic') => void
  onShowChoices?: (
    choices: string[],
    prompt: string,
    onSelect: (choice: string) => void
  ) => void
  onAskYesNo?: (
    question: string,
    onAnswer: (answer: boolean) => void
  ) => void
  onReveal?: (
    secret: string,
    wasCorrect: boolean,
    message: string
  ) => void
  onCelebrate?: (
    type: 'confetti' | 'fireworks' | 'sparkles',
    message: string
  ) => void
}

// Singleton callbacks object - set by React component
export const callbacks: MagicTrickCallbacks = {}

// --- Helper Functions ---

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const

function randomCard(): Card {
  return {
    suit: SUITS[Math.floor(Math.random() * SUITS.length)],
    rank: RANKS[Math.floor(Math.random() * RANKS.length)],
  }
}

function cardName(card: Card): string {
  return `${card.rank} of ${card.suit}`
}

function cardColor(card: Card): 'red' | 'black' {
  return card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black'
}

function generateCardChoices(secret: Card, count: number = 4): Card[] {
  const choices: Card[] = [secret]
  while (choices.length < count) {
    const decoy = randomCard()
    if (!choices.some(c => c.suit === decoy.suit && c.rank === decoy.rank)) {
      choices.push(decoy)
    }
  }
  // Shuffle
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
      ;[choices[i], choices[j]] = [choices[j], choices[i]]
  }
  return choices
}

// Export helpers for LLM to generate choices
export { generateCardChoices, cardName }

function sleep(ms: number) {
  return call(() => new Promise(r => setTimeout(r, ms)))
}

// ============================================================================
// SERVER AUTHORITY TOOLS
// Server executes first, output flows to client for presentation
// ============================================================================

/**
 * Pick Secret - Server Authority
 *
 * Server secretly picks something (card, number, or word).
 * Client shows a "thinking" animation.
 * The secret is stored server-side for later validation.
 */
export const pickSecretTool = defineIsomorphicTool({
  name: 'pick_secret',
  description: `Secretly pick something for the user to guess. Can pick:
- A card (for card tricks)
- A number between 1-100 (for number guessing)
- A word from a category (for word games)

The user won't see what you picked. Use give_hint to provide clues, then get_user_guess to let them guess.`,
  parameters: z.object({
    type: z.enum(['card', 'number', 'word']).describe('What type of secret to pick'),
    category: z.string().optional().describe('For word type: category like "animals", "colors", "foods"'),
    wordList: z.array(z.string()).optional().describe('For word type: specific words to choose from'),
    range: z.object({
      min: z.number(),
      max: z.number(),
    }).optional().describe('For number type: range to pick from (default 1-100)'),
    thinkingMessage: z.string().optional().describe('Message to show while "thinking"'),
  }),
  authority: 'server',
  approval: { server: 'none', client: 'none' },

  *server({ type, category, wordList, range }, _ctx) {
    // Reset game state
    const state = resetSession(DEFAULT_SESSION)

    yield* sleep(800) // Dramatic pause

    let picked: string
    let hint: string
    let secretType: 'card' | 'number' | 'word' = type

    switch (type) {
      case 'card': {
        state.secretCard = randomCard()
        picked = 'card'
        hint = `I've picked a ${cardColor(state.secretCard)} card...`
        break
      }
      case 'number': {
        const min = range?.min ?? 1
        const max = range?.max ?? 100
        state.secretNumber = Math.floor(Math.random() * (max - min + 1)) + min
        picked = 'number'
        hint = `I'm thinking of a number between ${min} and ${max}...`
        break
      }
      case 'word': {
        const words = wordList ?? ['apple', 'banana', 'cherry', 'dragon', 'elephant']
        state.secretWord = words[Math.floor(Math.random() * words.length)]
        picked = 'word'
        hint = category
          ? `I've chosen a ${category}...`
          : `I've chosen a word with ${state.secretWord.length} letters...`
        break
      }
    }

    state.lastHint = hint
    return { picked, hint, ready: true, secretType }
  },

  *client(serverOutput, _ctx, params) {
    const message = params.thinkingMessage ?? 'The magician is concentrating...'
    callbacks.onThinking?.(message)
    yield* sleep(500)
    return { displayed: true, hint: serverOutput.hint }
  },

})

/**
 * Give Hint - Server Authority
 *
 * Server generates a hint about the secret.
 * Client displays it with style.
 */
export const giveHintTool = defineIsomorphicTool({
  name: 'give_hint',
  description: `Give the user a hint about the secret. Be creative with your hints!

For cards: hint about color, suit, high/low, face card, etc.
For numbers: hint about higher/lower, even/odd, divisibility, etc.
For words: hint about first letter, length, rhymes with, etc.

The style affects how the hint is displayed (mystical, playful, or dramatic).`,
  parameters: z.object({
    hint: z.string().describe('The hint to give the user'),
    style: z.enum(['mystical', 'playful', 'dramatic']).default('mystical').describe('Visual style for the hint'),
  }),
  authority: 'server',
  approval: { server: 'none', client: 'none' },

  *server({ hint }, _ctx) {
    const state = getSession(DEFAULT_SESSION)
    state.lastHint = hint

    // Add some context if we have a secret (for LLM to know)
    let context = ''
    if (state.secretCard) {
      context = `(Secret: ${cardName(state.secretCard)})`
    } else if (state.secretNumber !== null) {
      context = `(Secret: ${state.secretNumber})`
    } else if (state.secretWord) {
      context = `(Secret: ${state.secretWord})`
    }

    return { hint, context, guessCount: state.guessCount }
  },

  *client(serverOutput, _ctx, params) {
    callbacks.onShowHint?.(serverOutput.hint, params.style)
    yield* sleep(300)
    return { shown: true }
  },

})

/**
 * Reveal Answer - Server Authority
 *
 * Server reveals the secret with a message.
 * Client shows dramatic reveal animation.
 */
export const revealAnswerTool = defineIsomorphicTool({
  name: 'reveal_answer',
  description: `Dramatically reveal the secret! Use this after the user has guessed (correctly or not), or if they give up.

Include a personalized message based on how they did.`,
  parameters: z.object({
    message: z.string().describe('Message to show with the reveal'),
    wasCorrect: z.boolean().describe('Whether their last guess was correct'),
  }),
  authority: 'server',
  approval: { server: 'none', client: 'none' },

  *server({ message, wasCorrect }, _ctx) {
    const state = getSession(DEFAULT_SESSION)

    yield* sleep(1000) // Suspense!

    let secret: string
    if (state.secretCard) {
      secret = cardName(state.secretCard)
    } else if (state.secretNumber !== null) {
      secret = String(state.secretNumber)
    } else if (state.secretWord) {
      secret = state.secretWord
    } else {
      secret = 'nothing (no secret was picked!)'
    }

    return {
      secret,
      wasCorrect,
      message,
      totalGuesses: state.guessCount,
    }
  },

  *client(serverOutput, _ctx, _params) {
    callbacks.onReveal?.(
      serverOutput.secret,
      serverOutput.wasCorrect,
      serverOutput.message
    )
    yield* sleep(2000)
    return { revealed: true }
  },

})

/**
 * Celebrate - Server Authority
 *
 * Server determines celebration context.
 * Client shows visual effects.
 */
export const celebrateTool = defineIsomorphicTool({
  name: 'celebrate',
  description: `Celebrate with visual effects! Use when:
- User guesses correctly
- Game is complete
- Any exciting moment

Choose from confetti, fireworks, or sparkles.`,
  parameters: z.object({
    type: z.enum(['confetti', 'fireworks', 'sparkles']).describe('Type of celebration'),
    message: z.string().describe('Celebratory message to show'),
  }),
  authority: 'server',
  approval: { server: 'none', client: 'none' },

  *server({ type, message }, _ctx) {
    const state = getSession(DEFAULT_SESSION)

    yield* sleep(300) // Brief pause for dramatic effect

    return {
      type,
      message,
      totalGuesses: state.guessCount,
      timestamp: new Date().toISOString(),
    }
  },

  *client(serverOutput, _ctx, _params) {
    callbacks.onCelebrate?.(serverOutput.type, serverOutput.message)

    const duration = serverOutput.type === 'fireworks' ? 3000
      : serverOutput.type === 'confetti' ? 2000
        : 1500
    yield* sleep(duration)

    return { celebrated: true }
  },

})

// ============================================================================
// CLIENT AUTHORITY TOOLS
// Client gets user input, sends to server for validation
// ============================================================================

/**
 * Get User Guess - Client Authority
 *
 * Client presents choices to user and collects their selection.
 * Server validates the guess against the secret.
 *
 * NOTE: The choices are passed as parameters by the LLM or generated
 * by the server validation step. The client cannot access game state.
 */
export const getUserGuessTool = defineIsomorphicTool({
  name: 'get_user_guess',
  description: `Present choices to the user and get their guess.

For cards: provide 4 card names as customChoices
For numbers: provide number options as customChoices
For words: provide word options as customChoices

IMPORTANT: You must provide the choices in the customChoices parameter!
The server will validate the guess and tell you if it's correct.`,
  parameters: z.object({
    prompt: z.string().describe('Question or prompt to show the user'),
    customChoices: z.array(z.string()).describe('The choices to present to the user'),
  }),
  authority: 'client',
  approval: { server: 'none', client: 'none' },

  *client(params, ctx) {
    const choices = params.customChoices

    if (!choices || choices.length === 0) {
      throw new Error('No choices provided! The LLM must provide customChoices.')
    }

    // Try ctx.waitFor() first (new pattern), fall back to callbacks
    if (ctx.waitFor) {
      const response = yield* ctx.waitFor<
        { choices: string[]; prompt: string },
        { selectedChoice: string }
      >('select-choice', {
        choices,
        prompt: params.prompt,
      })
      return { guess: response.selectedChoice, choices }
    }

    // Legacy callback pattern
    const selected = yield* call(() => new Promise<string>((resolve, reject) => {
      if (callbacks.onShowChoices) {
        callbacks.onShowChoices(choices, params.prompt, (choice) => {
          resolve(choice)
        })
      } else {
        // Fallback for testing: auto-select first
        setTimeout(() => resolve(choices[0] ?? 'test'), 100)
      }
      // Timeout after 60 seconds
      setTimeout(() => reject(new Error('Selection timeout')), 60000)
    }))

    return { guess: selected, choices }
  },

  *server(_params, _ctx, clientOutput) {
    const state = getSession(DEFAULT_SESSION)
    const guess = clientOutput.guess

    state.guessCount++

    let isCorrect = false
    let feedback = ''

    // Validate based on what secret we have
    if (state.secretCard) {
      isCorrect = guess === cardName(state.secretCard)
      if (isCorrect) {
        feedback = `Yes! The ${guess} is correct!`
      } else {
        // Give a hint
        const guessColor = guess.includes('hearts') || guess.includes('diamonds') ? 'red' : 'black'
        const secretColor = cardColor(state.secretCard)
        if (guessColor !== secretColor) {
          feedback = `Not quite. The secret card is ${secretColor}, not ${guessColor}.`
        } else {
          feedback = `Close! It's also a ${secretColor} card, but not that one.`
        }
      }
    } else if (state.secretNumber !== null) {
      const guessNum = parseInt(guess, 10)
      isCorrect = guessNum === state.secretNumber
      if (isCorrect) {
        feedback = `Correct! It was ${state.secretNumber}!`
      } else if (guessNum < state.secretNumber) {
        feedback = `Higher! ${guess} is too low.`
      } else {
        feedback = `Lower! ${guess} is too high.`
      }
    } else if (state.secretWord) {
      isCorrect = guess.toLowerCase() === state.secretWord.toLowerCase()
      if (isCorrect) {
        feedback = `Yes! "${state.secretWord}" is correct!`
      } else {
        feedback = `Not "${guess}". Try again!`
      }
    } else {
      feedback = 'No secret was picked! Use pick_secret first.'
    }

    return {
      guess,
      isCorrect,
      feedback,
      guessNumber: state.guessCount,
    }
  },

})

/**
 * Ask Yes/No - Client Authority
 *
 * Client asks user a yes/no question.
 * Server processes the answer.
 *
 * Great for "20 questions" style games or gathering info.
 */
export const askYesNoTool = defineIsomorphicTool({
  name: 'ask_yes_no',
  description: `Ask the user a yes/no question. Good for:
- Narrowing down guesses ("Is it a red card?")
- Gathering preferences ("Want another hint?")
- Confirming actions ("Ready to reveal?")

The server receives the answer and can respond accordingly.`,
  parameters: z.object({
    question: z.string().describe('The yes/no question to ask'),
    context: z.string().optional().describe('Why you\'re asking (for internal tracking)'),
  }),
  authority: 'client',
  approval: { server: 'none', client: 'none' },

  *client(params, ctx) {
    // Try ctx.waitFor() first (new pattern), fall back to callbacks
    if (ctx.waitFor) {
      const response = yield* ctx.waitFor<
        { question: string },
        { answer: boolean }
      >('yes-no', {
        question: params.question,
      })
      return { answer: response.answer, question: params.question }
    }

    // Legacy callback pattern
    const answer = yield* call(() => new Promise<boolean>((resolve, reject) => {
      if (callbacks.onAskYesNo) {
        callbacks.onAskYesNo(params.question, (answer) => {
          resolve(answer)
        })
      } else {
        // Fallback: random for testing
        setTimeout(() => resolve(Math.random() > 0.5), 100)
      }
      setTimeout(() => reject(new Error('Response timeout')), 60000)
    }))

    return { answer, question: params.question }
  },

  *server(_params, _ctx, clientOutput) {
    // Server can use this info for game logic
    return {
      question: clientOutput.question,
      answer: clientOutput.answer,
      response: clientOutput.answer ? 'User said YES' : 'User said NO',
    }
  },

})

// ============================================================================
// V7 HANDOFF TOOLS (Server-authority with two-phase execution)
// Server picks in phase 1, client shows choices, server validates in phase 2
// ============================================================================

/**
 * Guess The Card - V7 Handoff Pattern
 *
 * A complete "pick a card and guess" trick in a single tool call.
 *
 * Phase 1 (before):
 * - Server picks a random card
 * - Generates decoy choices
 * - Returns handoff data: { secret, choices, hint }
 *
 * Client:
 * - Shows the choices to the user
 * - Gets their guess
 * - Returns: { guess }
 *
 * Phase 2 (after):
 * - Server receives the cached secret from phase 1 (NOT re-picked!)
 * - Compares guess to secret
 * - Returns the result to the LLM
 *
 * This demonstrates the key benefit of V7: the secret is picked ONCE in phase 1
 * and preserved for phase 2, even though the server operation runs twice.
 */
export const guessTheCardTool = defineIsomorphicTool({
  name: 'guess_the_card',
  description: `A complete card guessing game in one call.

Picks a random card, shows choices to the user, validates their guess.
All in one atomic operation - no need to call pick_secret and get_user_guess separately.

The secret is picked once and preserved, even if the user takes time to guess.`,
  parameters: z.object({
    prompt: z.string().optional().describe('Custom prompt to show the user (default: "Which card am I thinking of?")'),
    numChoices: z.number().min(2).max(10).optional().describe('Number of choices to show (default: 4)'),
    dramaticReveal: z.boolean().optional().describe('Whether to make the reveal dramatic'),
  }),
  authority: 'server',
  approval: { server: 'none', client: 'none' },

  *server({ prompt, numChoices, dramaticReveal }, ctx) {
    // Use the V7 handoff pattern for true two-phase execution
    return yield* ctx.handoff({
      // Phase 1: Pick the secret and generate choices (runs ONCE)
      *before() {
        yield* sleep(500) // Dramatic pause while "shuffling"

        const secret = randomCard()
        const choices = generateCardChoices(secret, numChoices ?? 4)
        const choiceNames = choices.map(c => cardName(c))
        const hint = `I'm thinking of a ${cardColor(secret)} card...`

        // This data is:
        // 1. Sent to the client for display
        // 2. Cached for phase 2 (the secret won't be re-picked!)
        return {
          secret: cardName(secret),
          secretColor: cardColor(secret),
          choices: choiceNames,
          hint,
          prompt: prompt ?? 'Which card am I thinking of?',
        }
      },

      // Phase 2: Validate the guess (runs ONCE, after client returns)
      *after(handoff, clientOutput: { guess: string }) {
        const isCorrect = clientOutput.guess === handoff.secret

        if (dramaticReveal) {
          yield* sleep(1500) // Suspenseful pause
        }

        // Update game state for tracking
        const state = getSession(DEFAULT_SESSION)
        state.guessCount++

        let feedback: string
        if (isCorrect) {
          feedback = `Incredible! You correctly guessed the ${handoff.secret}! 🎉`
        } else {
          const guessColor = clientOutput.guess.includes('hearts') || clientOutput.guess.includes('diamonds') ? 'red' : 'black'
          if (guessColor !== handoff.secretColor) {
            feedback = `Not quite! You guessed a ${guessColor} card, but the secret was a ${handoff.secretColor} card: ${handoff.secret}`
          } else {
            feedback = `Close! The ${clientOutput.guess} is also ${handoff.secretColor}, but the secret was ${handoff.secret}`
          }
        }

        return {
          guess: clientOutput.guess,
          secret: handoff.secret,
          isCorrect,
          feedback,
          hint: handoff.hint,
          guessNumber: state.guessCount,
        }
      },
    })
  },

  *client(handoffData, ctx, _params) {
    // handoffData is the result from before() - the handoff payload
    // Cast through unknown because TypeScript infers TServerOutput as after()'s return type
    const data = handoffData as unknown as {
      secret: string
      secretColor: string
      choices: string[]
      hint: string
      prompt: string
    }

    // Try ctx.waitFor() first (new pattern), fall back to callbacks
    if (ctx.waitFor) {
      // First show the hint, then get the choice
      // For now, we'll combine into a single waitFor with the hint in the payload
      const response = yield* ctx.waitFor<
        { choices: string[]; prompt: string; hint: string },
        { selectedChoice: string }
      >('select-choice', {
        choices: data.choices,
        prompt: data.prompt,
        hint: data.hint,
      })
      return { guess: response.selectedChoice }
    }

    // Legacy callback pattern
    // Show the hint
    callbacks.onShowHint?.(data.hint, 'mystical')

    // Wait for user selection
    const selected = yield* call(() => new Promise<string>((resolve, reject) => {
      if (callbacks.onShowChoices) {
        callbacks.onShowChoices(data.choices, data.prompt, (choice) => {
          resolve(choice)
        })
      } else {
        // Fallback for testing: auto-select first
        setTimeout(() => resolve(data.choices[0] ?? 'test'), 100)
      }
      // Timeout after 60 seconds
      setTimeout(() => reject(new Error('Selection timeout')), 60000)
    }))

    return { guess: selected }
  },
})

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Reset all game state - call between games
 */
export function resetGame(sessionId: string = DEFAULT_SESSION) {
  resetSession(sessionId)
}

/**
 * Get current game state (for debugging/server-side use only)
 */
export function getGameState(sessionId: string = DEFAULT_SESSION): GameState {
  return getSession(sessionId)
}

/**
 * All magic trick tools
 */
export const magicTrickTools = [
  // Server authority (simple)
  pickSecretTool,
  giveHintTool,
  revealAnswerTool,
  celebrateTool,
  // Client authority
  getUserGuessTool,
  askYesNoTool,
  // V7 Handoff (server authority with two-phase execution)
  guessTheCardTool,
]

/**
 * System prompt for magic tricks
 */
export const MAGIC_TRICK_SYSTEM_PROMPT = `You are a charismatic AI magician performing interactive magic tricks.

## Available Tools

### V7 Handoff (RECOMMENDED for card tricks):
- guess_the_card: Complete card guessing game in ONE call!
  - Picks a secret card, shows choices, validates guess
  - All in one atomic operation - easier and more reliable

### Server Authority (you control, user sees effects):
- pick_secret: Secretly pick a card, number, or word
- give_hint: Give the user creative hints
- reveal_answer: Dramatically reveal the secret
- celebrate: Show celebration effects

### Client Authority (user provides input, you validate):
- get_user_guess: Show choices and get user's guess
- ask_yes_no: Ask user yes/no questions

## Tool Protocol

CRITICAL: When you call a tool, WAIT for the result before continuing.

### For guess_the_card (RECOMMENDED for card tricks):
Just call it! No need to provide choices - it handles everything:
\`\`\`
guess_the_card({ prompt: "Pick the card I'm thinking of!" })
\`\`\`
Result includes: { guess, secret, isCorrect, feedback }

### For get_user_guess (manual flow):
You MUST provide the choices in customChoices parameter. Example:
- For cards: ["A of hearts", "K of spades", "7 of diamonds", "3 of clubs"]
- For numbers: ["42", "67", "23", "89"]
- For words: ["elephant", "giraffe", "penguin", "tiger"]

The secret should be included among the choices!

## Game Flow

### Quick Card Trick (using guess_the_card):
1. User requests a card trick
2. Call guess_the_card() - it picks, shows, and validates in one step
3. Based on result, celebrate or play again!

### Advanced Flow (multiple steps):
1. User requests a trick
2. You call pick_secret to secretly pick something
3. Optionally give_hint for clues
4. Call get_user_guess with choices (include the secret!)
5. Based on result, either celebrate or give more hints
6. Call reveal_answer at the end

## Example Quick Card Trick

User: "Do a card trick!"
You: *call guess_the_card({ prompt: "Which card am I thinking of?" })*
[wait - you get: { guess: "7 of diamonds", secret: "7 of diamonds", isCorrect: true, feedback: "..." }]
You: "Incredible! You correctly guessed the 7 of diamonds!"
You: *call celebrate({ type: "confetti", message: "Amazing!" })*
`
