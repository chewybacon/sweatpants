/**
 * Browser Context Tests
 *
 * Tests the browser context DSL with ctx.render().
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import {
  createBrowserContext,
  createExecutionState,
  type RenderableProps,
} from '../browser-context'
import {
  createRuntime,
  COMPONENT_EMISSION_TYPE,
  type RuntimeConfig,
  type ComponentEmissionPayload,
} from '../emissions'

// =============================================================================
// TEST COMPONENTS
// =============================================================================

interface AskQuestionProps extends RenderableProps<{ answer: string }> {
  question: string
  options?: string[]
}

function AskQuestion(_props: AskQuestionProps) {
  return null // Not actually rendered in tests
}
AskQuestion.displayName = 'AskQuestion'

interface ThinkingIndicatorProps extends RenderableProps<void> {
  message: string
}

function ThinkingIndicator(_props: ThinkingIndicatorProps) {
  return null
}
ThinkingIndicator.displayName = 'ThinkingIndicator'

interface CardPickerProps extends RenderableProps<{ card: string }> {
  choices: string[]
  hint?: string
}

function CardPicker(_props: CardPickerProps) {
  return null
}
// No displayName - should use function name

// =============================================================================
// TESTS
// =============================================================================

describe('Browser Context', () => {
  describe('createBrowserContext', () => {
    it('should create context with render method', async () => {
      const result = await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (_emission, respond) => {
              // Simulate user clicking "yes"
              setTimeout(() => respond({ answer: 'yes' }), 10)
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'test_tool',
        })

        const response = yield* ctx.render(AskQuestion, {
          question: 'Do you agree?',
          options: ['yes', 'no'],
        })

        return response
      })

      expect(result).toEqual({ answer: 'yes' })
    })

    it('should track emissions in execution state', async () => {
      const executionState = createExecutionState('call-1', 'test_tool')

      await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (_emission, respond) => {
              setTimeout(() => respond({ answer: 'yes' }), 5)
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'test_tool',
          executionState,
        })

        yield* ctx.render(AskQuestion, { question: 'Q1?' })
        yield* ctx.render(AskQuestion, { question: 'Q2?' })
      })

      expect(executionState.emissions).toHaveLength(2)
      expect(executionState.emissions[0]!.payload.componentKey).toBe('AskQuestion')
      expect(executionState.emissions[0]!.payload.props).toEqual({ question: 'Q1?' })
      expect(executionState.emissions[1]!.payload.props).toEqual({ question: 'Q2?' })
    })

    it('should use function name when displayName not set', async () => {
      const executionState = createExecutionState('call-1', 'test_tool')

      await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (_emission, respond) => {
              setTimeout(() => respond({ card: 'Ace of Spades' }), 5)
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'test_tool',
          executionState,
        })

        yield* ctx.render(CardPicker, { choices: ['A', 'B', 'C'] })
      })

      expect(executionState.emissions[0]!.payload.componentKey).toBe('CardPicker')
    })

    it('should include component reference in emission payload', async () => {
      let capturedPayload: ComponentEmissionPayload | undefined

      await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (emission, respond) => {
              capturedPayload = emission.payload as ComponentEmissionPayload
              respond({ answer: 'yes' })
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'test_tool',
        })

        yield* ctx.render(AskQuestion, { question: 'Test?' })
      })

      expect(capturedPayload).toBeDefined()
      expect(capturedPayload!._component).toBe(AskQuestion)
    })
  })

  describe('Fire-and-forget pattern', () => {
    it('should support components that resolve immediately', async () => {
      const responses: unknown[] = []

      await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (_emission, respond) => {
              // Simulate fire-and-forget: resolve immediately with undefined
              respond(undefined)
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'test_tool',
        })

        // ThinkingIndicator would call onRespond(undefined) immediately in useEffect
        const r1 = yield* ctx.render(ThinkingIndicator, { message: 'Loading...' })
        responses.push(r1)

        const r2 = yield* ctx.render(ThinkingIndicator, { message: 'Almost done...' })
        responses.push(r2)

        // Then a real interaction
        const config2: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (_emission, respond) => {
              respond({ answer: 'done' })
            },
          },
        }
        const runtime2 = createRuntime(config2, 'call-2')
        const ctx2 = createBrowserContext({
          runtime: runtime2,
          callId: 'call-2',
          toolName: 'test_tool',
        })

        const r3 = yield* ctx2.render(AskQuestion, { question: 'Final question?' })
        responses.push(r3)
      })

      expect(responses).toEqual([undefined, undefined, { answer: 'done' }])
    })
  })

  describe('waitFor method', () => {
    it('should delegate to runtime.emit', async () => {
      const result = await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            'custom-type': (emission, respond) => {
              respond({ custom: 'response', payload: emission.payload })
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'test_tool',
        })

        return yield* ctx.waitFor<{ data: string }, { custom: string; payload: unknown }>(
          'custom-type',
          { data: 'test' }
        )
      })

      expect(result).toEqual({ custom: 'response', payload: { data: 'test' } })
    })
  })

  describe('Real-world tool pattern', () => {
    it('should support a card guessing game flow', async () => {
      interface CardGuessProps extends RenderableProps<{ guess: string }> {
        choices: string[]
        hint: string
      }

      function CardGuess(_props: CardGuessProps) {
        return null
      }

      interface RevealProps extends RenderableProps<void> {
        secret: string
        correct: boolean
      }

      function Reveal(_props: RevealProps) {
        return null
      }

      const executionState = createExecutionState('call-1', 'guess_card')
      let guessCount = 0

      const result = await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            [COMPONENT_EMISSION_TYPE]: (emission, respond) => {
              const payload = emission.payload as ComponentEmissionPayload
              if (payload.componentKey === 'CardGuess') {
                guessCount++
                // User picks the first choice
                respond({ guess: (payload.props as unknown as CardGuessProps).choices[0] })
              } else if (payload.componentKey === 'Reveal') {
                // Fire-and-forget
                respond(undefined)
              }
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        const ctx = createBrowserContext({
          runtime,
          callId: 'call-1',
          toolName: 'guess_card',
          executionState,
        })

        // Simulate tool execution
        const secret = 'Ace of Spades'
        const choices = ['Ace of Spades', 'King of Hearts', '7 of Clubs', 'Queen of Diamonds']

        const { guess } = yield* ctx.render(CardGuess, {
          choices,
          hint: 'I picked a black card...',
        })

        const correct = guess === secret

        yield* ctx.render(Reveal, {
          secret,
          correct,
        })

        return { guess, secret, correct }
      })

      expect(result).toEqual({
        guess: 'Ace of Spades',
        secret: 'Ace of Spades',
        correct: true,
      })
      expect(guessCount).toBe(1)
      expect(executionState.emissions).toHaveLength(2)
      expect(executionState.emissions[0]!.payload.componentKey).toBe('CardGuess')
      expect(executionState.emissions[1]!.payload.componentKey).toBe('Reveal')
    })
  })
})
