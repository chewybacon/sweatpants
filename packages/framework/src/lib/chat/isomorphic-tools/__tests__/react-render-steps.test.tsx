/**
 * React Render Steps - yield* ctx.render(<JSX />)
 *
 * This test proves that client generators can yield actual React elements
 * that render inline in the chat stream and resume when the user interacts.
 *
 * The vision:
 * ```tsx
 * defineIsomorphicTool({
 *   name: 'ask_question',
 *   *client(params, ctx) {
 *     const answer = yield* ctx.render(
 *       <YesNoPrompt question={params.question} />
 *     )
 *     return { question: params.question, answer }
 *   }
 * })
 * ```
 *
 * Key ideas:
 * 1. ctx.render() yields a React element as a step
 * 2. The platform renders it inline (like a message)
 * 3. The component calls onRespond() when user interacts
 * 4. The generator resumes with that response
 * 5. The step is recorded in the trail for persistence
 */
import { describe, it, expect } from 'vitest'
import {
  run,
  createChannel,
  createSignal,
  spawn,
  each,
  sleep,
  type Operation,
  type Channel,
} from 'effection'
import React, { type ReactElement } from 'react'

// =============================================================================
// STEP TYPES
// =============================================================================

/**
 * A step that can contain either:
 * - A type+payload (for type-based rendering)
 * - A React element (for direct rendering)
 */
interface Step<TPayload = unknown, TResponse = unknown> {
  id: string
  kind: 'emit' | 'prompt'
  timestamp: number
  status: 'pending' | 'complete'
  response?: TResponse

  // Type-based step
  type?: string
  payload?: TPayload

  // React-direct step
  element?: ReactElement
}

interface PendingStep<TPayload = unknown, TResponse = unknown> {
  step: Step<TPayload, TResponse>
  respond: (response: TResponse) => void
}

interface ExecutionTrail {
  callId: string
  toolName: string
  steps: Step[]
  result?: unknown
  status: 'running' | 'complete' | 'error' | 'cancelled'
  startedAt: number
  completedAt?: number
}

// =============================================================================
// EXTENSIBLE STEP CONTEXT
// =============================================================================

/**
 * Base context - works on any platform
 */
interface BaseStepContext {
  /** Fire-and-forget step */
  emit<TPayload>(type: string, payload: TPayload): Operation<void>

  /** Step that waits for response */
  prompt<TPayload, TResponse>(type: string, payload: TPayload): Operation<TResponse>
}

/**
 * React-enhanced context - adds render() for JSX
 */
interface ReactStepContext extends BaseStepContext {
  /**
   * Render a React element inline and wait for response.
   *
   * The element should accept an `onRespond` prop that it calls
   * when the user completes the interaction.
   *
   * @example
   * ```tsx
   * const answer = yield* ctx.render<boolean>(
   *   <YesNoPrompt question="Is it alive?" />
   * )
   * ```
   */
  render<TResponse>(element: ReactElement): Operation<TResponse>
}

/**
 * Create a React-enabled step context
 */
function createReactStepContext(
  callId: string,
  trail: ExecutionTrail,
  stepChannel: Channel<PendingStep<any, any>, void>
): ReactStepContext {
  let stepCounter = 0

  const ctx: ReactStepContext = {
    *emit<TPayload>(type: string, payload: TPayload): Operation<void> {
      const step: Step<TPayload> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'emit',
        type,
        payload,
        timestamp: Date.now(),
        status: 'complete',
      }
      trail.steps.push(step)
      yield* stepChannel.send({ step, respond: () => {} })
    },

    *prompt<TPayload, TResponse>(
      type: string,
      payload: TPayload
    ): Operation<TResponse> {
      const step: Step<TPayload, TResponse> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'prompt',
        type,
        payload,
        timestamp: Date.now(),
        status: 'pending',
      }
      trail.steps.push(step)

      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      yield* stepChannel.send({
        step,
        respond: (response: TResponse) => {
          step.response = response
          step.status = 'complete'
          responseSignal.send(response)
        },
      })

      const { value } = yield* subscription.next()
      return value as TResponse
    },

    *render<TResponse>(element: ReactElement): Operation<TResponse> {
      const step: Step<unknown, TResponse> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'prompt',
        type: '__react__',
        element,
        timestamp: Date.now(),
        status: 'pending',
      }
      trail.steps.push(step)

      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      yield* stepChannel.send({
        step,
        respond: (response: TResponse) => {
          step.response = response
          step.status = 'complete'
          responseSignal.send(response)
        },
      })

      const { value } = yield* subscription.next()
      return value as TResponse
    },
  }

  return ctx
}

// =============================================================================
// STEP RUNNER
// =============================================================================

function* runClientGenerator<TResult>(
  callId: string,
  toolName: string,
  generator: (ctx: ReactStepContext) => Operation<TResult>,
  stepChannel: Channel<PendingStep<any, any>, void>
): Operation<{ trail: ExecutionTrail; result: TResult }> {
  const trail: ExecutionTrail = {
    callId,
    toolName,
    steps: [],
    status: 'running',
    startedAt: Date.now(),
  }

  const ctx = createReactStepContext(callId, trail, stepChannel)

  try {
    const result = yield* generator(ctx)
    trail.result = result
    trail.status = 'complete'
    trail.completedAt = Date.now()
    return { trail, result }
  } catch (error) {
    trail.status = 'error'
    trail.completedAt = Date.now()
    throw error
  }
}

// =============================================================================
// MOCK REACT COMPONENTS (for testing)
// =============================================================================

/**
 * Props that renderable components receive.
 * The framework injects `onRespond` for the component to call.
 */
interface RenderableProps<T> {
  onRespond?: (value: T) => void
}

/** Yes/No prompt component */
interface YesNoPromptProps extends RenderableProps<boolean> {
  question: string
  questionNumber?: number
}

function YesNoPrompt({ question, questionNumber, onRespond }: YesNoPromptProps) {
  // In real React, this would render buttons
  // For testing, we just verify the structure
  return React.createElement('div', { 
    'data-testid': 'yes-no-prompt',
    'data-question': question,
    'data-question-number': questionNumber,
  }, [
    React.createElement('span', { key: 'q' }, question),
    React.createElement('button', { 
      key: 'yes',
      onClick: () => onRespond?.(true) 
    }, 'Yes'),
    React.createElement('button', { 
      key: 'no',
      onClick: () => onRespond?.(false) 
    }, 'No'),
  ])
}

/** Guess confirmation component */
interface GuessConfirmProps extends RenderableProps<boolean> {
  guess: string
}

function GuessConfirm({ guess, onRespond }: GuessConfirmProps) {
  return React.createElement('div', {
    'data-testid': 'guess-confirm',
    'data-guess': guess,
  }, [
    React.createElement('span', { key: 'g' }, `Is it "${guess}"?`),
    React.createElement('button', { 
      key: 'yes',
      onClick: () => onRespond?.(true) 
    }, 'Yes!'),
    React.createElement('button', { 
      key: 'no',
      onClick: () => onRespond?.(false) 
    }, 'No'),
  ])
}

/** Narration component (no response needed) */
interface NarrationProps {
  text: string
  style?: 'intro' | 'thinking' | 'victory' | 'defeat'
}

function Narration({ text, style }: NarrationProps) {
  return React.createElement('div', {
    'data-testid': 'narration',
    'data-style': style,
  }, text)
}

// =============================================================================
// REACT PLATFORM SIMULATOR
// =============================================================================

/**
 * Simulates a React platform that renders steps.
 */
interface ReactPlatformSimulator {
  /** All rendered steps */
  rendered: Step[]
  /** Simulated user responses for prompts */
  responses: Map<string, (element: ReactElement) => unknown>
  /** Process a pending step */
  handle: (pending: PendingStep) => void
}

function createReactPlatformSimulator(): ReactPlatformSimulator {
  const rendered: Step[] = []
  const responses = new Map<string, (element: ReactElement) => unknown>()

  return {
    rendered,
    responses,
    handle(pending) {
      rendered.push(pending.step)

      if (pending.step.kind === 'prompt') {
        if (pending.step.type === '__react__' && pending.step.element) {
          // React element - find handler by component type
          const element = pending.step.element
          const componentName = typeof element.type === 'function' 
            ? element.type.name 
            : String(element.type)
          
          const handler = responses.get(componentName)
          if (handler) {
            const response = handler(element)
            pending.respond(response)
          } else {
            throw new Error(`No response handler for React component: ${componentName}`)
          }
        } else if (pending.step.type) {
          // Type-based - find handler by type
          const handler = responses.get(pending.step.type)
          if (handler) {
            const response = handler(pending.step.payload as any)
            pending.respond(response)
          } else {
            throw new Error(`No response handler for step type: ${pending.step.type}`)
          }
        }
      }
    },
  }
}

// =============================================================================
// TWENTY QUESTIONS WITH ctx.render()
// =============================================================================

interface TwentyQuestionsResult {
  won: boolean
  questionsAsked: number
  finalGuess: string
  answers: Array<{ question: string; answer: boolean }>
}

/**
 * Twenty Questions game using ctx.render() for React elements
 */
function* twentyQuestionsWithReact(
  ctx: ReactStepContext
): Operation<TwentyQuestionsResult> {
  const answers: Array<{ question: string; answer: boolean }> = []
  let questionNumber = 0

  // Intro narration (fire and forget)
  yield* ctx.render(
    React.createElement(Narration, {
      text: "Think of something, and I'll try to guess it!",
      style: 'intro',
    })
  )

  // Question 1: Is it alive?
  questionNumber++
  const isAlive = yield* ctx.render<boolean>(
    React.createElement(YesNoPrompt, {
      question: 'Is it a living thing?',
      questionNumber,
    })
  )
  answers.push({ question: 'Is it a living thing?', answer: isAlive })

  let guess: string

  if (isAlive) {
    // Question 2: Animal?
    questionNumber++
    const isAnimal = yield* ctx.render<boolean>(
      React.createElement(YesNoPrompt, {
        question: 'Is it an animal?',
        questionNumber,
      })
    )
    answers.push({ question: 'Is it an animal?', answer: isAnimal })

    if (isAnimal) {
      // Question 3: Does it have 4 legs?
      questionNumber++
      const hasFourLegs = yield* ctx.render<boolean>(
        React.createElement(YesNoPrompt, {
          question: 'Does it have 4 legs?',
          questionNumber,
        })
      )
      answers.push({ question: 'Does it have 4 legs?', answer: hasFourLegs })

      guess = hasFourLegs ? 'Dog' : 'Bird'
    } else {
      // It's a plant
      questionNumber++
      const canEatIt = yield* ctx.render<boolean>(
        React.createElement(YesNoPrompt, {
          question: 'Can you eat it?',
          questionNumber,
        })
      )
      answers.push({ question: 'Can you eat it?', answer: canEatIt })

      guess = canEatIt ? 'Apple' : 'Oak Tree'
    }
  } else {
    // Not alive
    questionNumber++
    const isElectronic = yield* ctx.render<boolean>(
      React.createElement(YesNoPrompt, {
        question: 'Is it electronic?',
        questionNumber,
      })
    )
    answers.push({ question: 'Is it electronic?', answer: isElectronic })

    guess = isElectronic ? 'Computer' : 'Rock'
  }

  // Make the guess
  questionNumber++
  const correct = yield* ctx.render<boolean>(
    React.createElement(GuessConfirm, { guess })
  )

  // Victory or defeat narration
  yield* ctx.render(
    React.createElement(Narration, {
      text: correct ? `I knew it was "${guess}"!` : `Darn! I thought it was "${guess}".`,
      style: correct ? 'victory' : 'defeat',
    })
  )

  return {
    won: correct,
    questionsAsked: questionNumber,
    finalGuess: guess,
    answers,
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('React Render Steps - ctx.render(<JSX />)', () => {
  describe('Basic rendering', () => {
    it('should yield React elements as steps', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createReactPlatformSimulator()

        // Set up response handlers
        platform.responses.set('Narration', () => undefined) // No response needed
        platform.responses.set('YesNoPrompt', () => {
          // Simulate user answering "Yes" to all questions
          return true
        })
        platform.responses.set('GuessConfirm', () => true)

        // Spawn platform handler
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        // Run the game
        const { trail, result: gameResult } = yield* runClientGenerator(
          'call-1',
          'twenty_questions',
          twentyQuestionsWithReact,
          channel
        )

        yield* sleep(50)

        return { trail, gameResult, rendered: platform.rendered }
      })

      // Check the game result
      expect(result.gameResult.won).toBe(true)
      expect(result.gameResult.finalGuess).toBe('Dog') // alive=yes, animal=yes, 4legs=yes

      // Check the trail has React elements
      expect(result.trail.steps.length).toBeGreaterThan(0)
      
      // First step should be the intro narration
      const introStep = result.trail.steps[0]
      expect(introStep.type).toBe('__react__')
      expect(introStep.element).toBeDefined()
      expect((introStep.element?.type as Function).name).toBe('Narration')

      // Second step should be the first question
      const q1Step = result.trail.steps[1]
      expect(q1Step.type).toBe('__react__')
      expect((q1Step.element?.type as Function).name).toBe('YesNoPrompt')
      expect((q1Step.element?.props as YesNoPromptProps).question).toBe('Is it a living thing?')
      expect(q1Step.response).toBe(true)
    })

    it('should follow different branches based on answers', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createReactPlatformSimulator()

        let questionIndex = 0
        const answers = [
          true,  // Is it alive? Yes
          false, // Is it an animal? No (it's a plant)
          true,  // Can you eat it? Yes
          true,  // Is it an Apple? Yes
        ]

        platform.responses.set('Narration', () => undefined)
        platform.responses.set('YesNoPrompt', () => answers[questionIndex++])
        platform.responses.set('GuessConfirm', () => true)

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: gameResult } = yield* runClientGenerator(
          'call-2',
          'twenty_questions',
          twentyQuestionsWithReact,
          channel
        )

        yield* sleep(50)

        return { trail, gameResult }
      })

      expect(result.gameResult.won).toBe(true)
      expect(result.gameResult.finalGuess).toBe('Apple')
      expect(result.gameResult.answers).toEqual([
        { question: 'Is it a living thing?', answer: true },
        { question: 'Is it an animal?', answer: false },
        { question: 'Can you eat it?', answer: true },
      ])
    })

    it('should handle incorrect guess', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createReactPlatformSimulator()

        platform.responses.set('Narration', () => undefined)
        platform.responses.set('YesNoPrompt', () => false) // All no
        platform.responses.set('GuessConfirm', () => false) // Wrong guess

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { result: gameResult } = yield* runClientGenerator(
          'call-3',
          'twenty_questions',
          twentyQuestionsWithReact,
          channel
        )

        yield* sleep(50)

        return { gameResult }
      })

      expect(result.gameResult.won).toBe(false)
      expect(result.gameResult.finalGuess).toBe('Rock') // not alive, not electronic
    })
  })

  describe('Trail for React rendering', () => {
    it('should produce trail with elements that React can render', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createReactPlatformSimulator()

        platform.responses.set('Narration', () => undefined)
        platform.responses.set('YesNoPrompt', () => true)
        platform.responses.set('GuessConfirm', () => true)

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail } = yield* runClientGenerator(
          'call-4',
          'twenty_questions',
          twentyQuestionsWithReact,
          channel
        )

        yield* sleep(50)

        return trail
      })

      // The trail steps can be mapped to renderable items
      const renderableTimeline = result.steps.map((step) => ({
        id: step.id,
        timestamp: step.timestamp,
        status: step.status,
        // For React elements, we have the actual element
        element: step.element,
        // Response if any
        response: step.response,
        // Can determine if interactive
        isInteractive: step.kind === 'prompt' && step.type === '__react__',
      }))

      expect(renderableTimeline.length).toBeGreaterThan(0)
      
      // All React steps should have elements
      const reactSteps = renderableTimeline.filter(r => r.element)
      expect(reactSteps.length).toBe(renderableTimeline.length)

      // Interactive steps that expect a response (not Narration) should have responses
      // Narration returns undefined, which is fine
      const promptSteps = renderableTimeline.filter(r => {
        if (!r.isInteractive) return false
        const componentName = typeof r.element?.type === 'function' 
          ? r.element.type.name 
          : ''
        return componentName !== 'Narration'
      })
      expect(promptSteps.every(s => s.response !== undefined)).toBe(true)
    })
  })

  describe('Mixed type-based and React rendering', () => {
    it('should support both ctx.prompt() and ctx.render() in same generator', async () => {
      // A generator that uses both patterns
      function* mixedGenerator(ctx: ReactStepContext): Operation<{ a: boolean; b: string }> {
        // Type-based prompt
        const a = yield* ctx.prompt<{ q: string }, boolean>('yes-no', { q: 'Type-based?' })

        // React-based render
        const b = yield* ctx.render<string>(
          React.createElement('input', { placeholder: 'Enter text' })
        )

        return { a, b }
      }

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createReactPlatformSimulator()

        // Type-based handler
        platform.responses.set('yes-no', () => true)
        // React-based handler (by element type)
        platform.responses.set('input', () => 'Hello from input')

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: genResult } = yield* runClientGenerator(
          'call-5',
          'mixed_tool',
          mixedGenerator,
          channel
        )

        yield* sleep(50)

        return { trail, genResult }
      })

      expect(result.genResult).toEqual({ a: true, b: 'Hello from input' })
      expect(result.trail.steps).toHaveLength(2)
      
      // First step is type-based
      expect(result.trail.steps[0].type).toBe('yes-no')
      expect(result.trail.steps[0].payload).toEqual({ q: 'Type-based?' })
      
      // Second step is React-based
      expect(result.trail.steps[1].type).toBe('__react__')
      expect(result.trail.steps[1].element).toBeDefined()
    })
  })
})

// =============================================================================
// DESIGN NOTES
// =============================================================================

/**
 * ## What This Proves
 *
 * 1. **ctx.render(<JSX />)** - Tools can yield actual React elements
 * 2. **Elements in trail** - The execution trail contains the React elements
 * 3. **Response flow** - When component calls onRespond(), generator resumes
 * 4. **Mixed support** - Both type-based and React-based work together
 * 5. **Conditional branching** - Game logic works with different answer paths
 *
 * ## How React Platform Would Use This
 *
 * ```tsx
 * function ChatTimeline({ trail }: { trail: ExecutionTrail }) {
 *   return (
 *     <>
 *       {trail.steps.map((step) => {
 *         if (step.type === '__react__' && step.element) {
 *           // Clone element to inject onRespond
 *           return React.cloneElement(step.element, {
 *             key: step.id,
 *             onRespond: step.status === 'pending' 
 *               ? (value) => respondToStep(step.id, value)
 *               : undefined,
 *             disabled: step.status === 'complete',
 *             response: step.response,
 *           })
 *         }
 *         // Type-based fallback
 *         return <TypeBasedStepRenderer key={step.id} step={step} />
 *       })}
 *     </>
 *   )
 * }
 * ```
 *
 * ## Next Steps
 *
 * 1. **Integrate with tool definition** - defineIsomorphicTool with ctx.render
 * 2. **React demo** - weather-inline using this pattern (conditional UI)
 * 3. **Session integration** - Steps flow through useChatSession
 * 4. **Serialization** - How to persist trails with React elements
 */
