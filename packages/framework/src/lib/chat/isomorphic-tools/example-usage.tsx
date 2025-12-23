/**
 * Example: Type-Safe Client Handlers for Isomorphic Tools
 *
 * This file demonstrates how to use the builder pattern with type-safe
 * client handlers in a React application.
 *
 * NOT meant to be used directly - this is documentation/example code.
 */
import { z } from 'zod'
import {
  createIsomorphicTool,
  createHandoffHandler,
  createHandoffRegistry,
  narrowHandoff,
  type IsomorphicHandoffEvent,
} from './index'

// =============================================================================
// STEP 1: Define Tools with Builder Pattern
// =============================================================================

/**
 * Card guessing tool.
 *
 * Server picks a card, client shows choices, server validates.
 */
export const guessCardTool = createIsomorphicTool('guess_card')
  .description('A card guessing game')
  .parameters(z.object({
    prompt: z.string().optional(),
    numChoices: z.number().min(2).max(10).default(4),
  }))
  .authority('server')
  .handoff({
    // Phase 1: Server picks the card (runs ONCE)
    *before(params) {
      const suits = ['hearts', 'diamonds', 'clubs', 'spades']
      const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
      const secret = `${ranks[Math.floor(Math.random() * ranks.length)]} of ${suits[Math.floor(Math.random() * suits.length)]}`
      
      // Generate decoys + include secret
      const choices = [secret]
      while (choices.length < params.numChoices) {
        const card = `${ranks[Math.floor(Math.random() * ranks.length)]} of ${suits[Math.floor(Math.random() * suits.length)]}`
        if (!choices.includes(card)) choices.push(card)
      }
      choices.sort(() => Math.random() - 0.5) // Shuffle
      
      return {
        secret,
        choices,
        hint: params.prompt ?? 'Which card am I thinking of?',
      }
    },

    // Client shows the choices and gets user selection
    *client(handoff, _ctx, _params) {
      // In a real app, this would show UI and wait for user input
      // Here we just return a mock response
      return { guess: handoff.choices[0] }
    },

    // Phase 2: Server validates (runs ONCE after client)
    *after(handoff, client) {
      const correct = client.guess === handoff.secret
      return {
        guess: client.guess,
        secret: handoff.secret,
        correct,
        feedback: correct
          ? '🎉 Amazing! You guessed correctly!'
          : `❌ Not quite. The card was ${handoff.secret}`,
      }
    },
  })

/**
 * Number guessing tool.
 */
export const guessNumberTool = createIsomorphicTool('guess_number')
  .description('Guess a number between 1 and max')
  .parameters(z.object({ max: z.number().default(100) }))
  .authority('server')
  .handoff({
    *before(params) {
      return {
        target: Math.floor(Math.random() * params.max) + 1,
        range: { min: 1, max: params.max },
      }
    },
    *client(handoff) {
      return { guess: Math.floor(handoff.range.max / 2) }
    },
    *after(handoff, client) {
      const diff = Math.abs(client.guess - handoff.target)
      return {
        guess: client.guess,
        target: handoff.target,
        correct: diff === 0,
        hint: diff === 0 ? 'Correct!' : client.guess < handoff.target ? 'Higher!' : 'Lower!',
      }
    },
  })

// =============================================================================
// STEP 2: Create Type-Safe Handlers
// =============================================================================

/**
 * Handler for the card guessing tool.
 *
 * Notice how `handoff` is fully typed - you get IntelliSense for:
 * - handoff.secret (string)
 * - handoff.choices (string[])
 * - handoff.hint (string)
 *
 * And `respond` expects `{ guess: string }` because that's what the
 * client() function returns.
 */
const handleGuessCard = createHandoffHandler(guessCardTool, (handoff, params, respond) => {
  // Full type safety here!
  // handoff.secret, handoff.choices, handoff.hint are all typed
  // respond expects { guess: string }
  
  return (
    <div className="card-picker">
      <h3>{handoff.hint}</h3>
      <p>Number of choices: {params.numChoices}</p>
      <div className="choices">
        {handoff.choices.map((card) => (
          <button
            key={card}
            onClick={() => respond({ guess: card })}
            className="choice-button"
          >
            {card}
          </button>
        ))}
      </div>
    </div>
  )
})

/**
 * Handler for the number guessing tool.
 */
const handleGuessNumber = createHandoffHandler(guessNumberTool, (handoff, _params, respond) => {
  // handoff.target (number), handoff.range ({ min: number, max: number })
  // respond expects { guess: number }
  
  return (
    <div className="number-picker">
      <h3>Guess a number between {handoff.range.min} and {handoff.range.max}</h3>
      <input
        type="number"
        min={handoff.range.min}
        max={handoff.range.max}
        onChange={(e) => respond({ guess: parseInt(e.target.value, 10) })}
      />
    </div>
  )
})

// =============================================================================
// STEP 3: Create Registry
// =============================================================================

/**
 * Registry of all handoff handlers.
 *
 * Use this to dispatch events to the correct handler.
 */
export const handoffRegistry = createHandoffRegistry([
  handleGuessCard,
  handleGuessNumber,
])

// =============================================================================
// STEP 4: Use in React Component
// =============================================================================

interface ToolRendererProps {
  event: IsomorphicHandoffEvent
  onRespond: (output: unknown) => void
}

/**
 * Component that renders the appropriate UI for a handoff event.
 */
export function ToolRenderer({ event, onRespond }: ToolRendererProps) {
  // Option 1: Use registry (simplest)
  const ui = handoffRegistry.handle(event, onRespond)
  if (ui) return ui

  // Fallback for unknown tools
  return (
    <div className="unknown-tool">
      <p>Unknown tool: {event.toolName}</p>
      <pre>{JSON.stringify(event.serverOutput, null, 2)}</pre>
    </div>
  )
}

/**
 * Alternative: Use narrowHandoff for switch-style handling.
 *
 * This gives you a discriminated union pattern with full type safety.
 */
export function ToolRendererSwitch({ event, onRespond }: ToolRendererProps) {
  // Try to narrow to each tool type
  const card = narrowHandoff(guessCardTool, event, onRespond)
  if (card) {
    // card.handoff is typed as { secret: string, choices: string[], hint: string }
    // card.respond expects { guess: string }
    return (
      <div>
        <h3>{card.handoff.hint}</h3>
        {card.handoff.choices.map((choice) => (
          <button key={choice} onClick={() => card.respond({ guess: choice })}>
            {choice}
          </button>
        ))}
      </div>
    )
  }

  const number = narrowHandoff(guessNumberTool, event, onRespond)
  if (number) {
    // number.handoff is typed as { target: number, range: { min, max } }
    // number.respond expects { guess: number }
    return (
      <div>
        <h3>Pick a number ({number.handoff.range.min}-{number.handoff.range.max})</h3>
        <input
          type="number"
          onChange={(e) => number.respond({ guess: parseInt(e.target.value, 10) })}
        />
      </div>
    )
  }

  return <div>Unknown tool: {event.toolName}</div>
}

// =============================================================================
// TYPE INFERENCE DEMONSTRATION
// =============================================================================

/**
 * Type inference works perfectly with the builder pattern.
 * 
 * The key point: NO MANUAL CASTS NEEDED!
 * Types flow from the builder definition through to the React handlers.
 * 
 * Use the InferToolHandoff and InferToolClientOutput helpers from builder.ts
 * to extract types from tools:
 * 
 * ```typescript
 * import { InferToolHandoff, InferToolClientOutput } from './builder'
 * 
 * type CardHandoff = InferToolHandoff<typeof guessCardTool>
 * // { secret: string, choices: string[], hint: string }
 * 
 * type CardClient = InferToolClientOutput<typeof guessCardTool>
 * // { guess: string }
 * ```
 */
