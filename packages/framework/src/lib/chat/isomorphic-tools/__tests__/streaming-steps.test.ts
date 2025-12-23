/**
 * Streaming Steps - Client Tools as First-Class Chat Participants
 *
 * This explores a new paradigm where client-side tool execution yields
 * "steps" that render inline in the chat stream, just like messages.
 *
 * Core Ideas:
 * 1. Each `yield` from the generator becomes a renderable "step"
 * 2. Steps can be fire-and-forget (emit) or wait for response (prompt)
 * 3. All steps are recorded in a trail (like a monad) for persistence
 * 4. React renders steps inline with messages, not as separate overlays
 * 5. The final `return` is what goes back to the LLM
 *
 * The power of generators:
 * - Bidirectional: yield out UI, get back user input
 * - Suspendable: pause at any yield, resume when ready
 * - Sequential but async: steps happen in order, can wait for user
 * - Composable: sub-generators for complex flows
 * - Controllable: Effection gives us clean shutdown/cancellation
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel, createSignal, spawn, each, sleep, type Operation, type Channel } from 'effection'

// =============================================================================
// STEP TYPES
// =============================================================================

/**
 * A step emitted by the client generator.
 *
 * Steps are the "messages" that tool execution produces.
 */
interface Step<TPayload = unknown, TResponse = unknown> {
  /** Unique ID for this step */
  id: string
  /** Step type - routes to renderer */
  type: string
  /** Kind of step */
  kind: 'emit' | 'prompt'
  /** Data for rendering */
  payload: TPayload
  /** Timestamp when step was created */
  timestamp: number
  /** Layout hint for rendering */
  layout?: 'inline' | 'overlay' | 'fullscreen'
  /** For prompts: the response once provided */
  response?: TResponse
  /** Current status */
  status: 'pending' | 'complete'
}

/**
 * A pending step that needs a response (for prompts).
 */
interface PendingStep<TPayload = unknown, TResponse = unknown> {
  step: Step<TPayload, TResponse>
  respond: (response: TResponse) => void
}

/**
 * The execution trail - all steps from a tool execution.
 */
interface ExecutionTrail {
  /** Tool call ID */
  callId: string
  /** Tool name */
  toolName: string
  /** All steps in order */
  steps: Step[]
  /** Final result (once complete) */
  result?: unknown
  /** Execution status */
  status: 'running' | 'complete' | 'error' | 'cancelled'
  /** Start timestamp */
  startedAt: number
  /** End timestamp */
  completedAt?: number
}

// =============================================================================
// STEP CONTEXT
// =============================================================================

/**
 * Context passed to client generators for yielding steps.
 */
interface StepContext {
  /**
   * Emit a fire-and-forget step (no response needed).
   *
   * Use for: progress indicators, hints, status updates
   */
  emit<TPayload>(
    type: string,
    payload: TPayload,
    options?: { layout?: 'inline' | 'overlay' }
  ): Operation<void>

  /**
   * Emit a step and wait for user response.
   *
   * Use for: choices, forms, confirmations
   */
  prompt<TPayload, TResponse>(
    type: string,
    payload: TPayload,
    options?: { layout?: 'inline' | 'overlay' | 'fullscreen' }
  ): Operation<TResponse>
}

/**
 * Creates a step context that records steps to a trail and emits to channel.
 */
function createStepContext(
  callId: string,
  trail: ExecutionTrail,
  stepChannel: Channel<PendingStep<any, any>, void>
): StepContext {
  let stepCounter = 0

  function createStep<TPayload>(
    kind: 'emit' | 'prompt',
    type: string,
    payload: TPayload,
    layout?: 'inline' | 'overlay' | 'fullscreen'
  ): Step<TPayload> {
    return {
      id: `${callId}-step-${++stepCounter}`,
      type,
      kind,
      payload,
      timestamp: Date.now(),
      layout,
      status: kind === 'emit' ? 'complete' : 'pending',
    }
  }

  return {
    *emit<TPayload>(
      type: string,
      payload: TPayload,
      options?: { layout?: 'inline' | 'overlay' }
    ): Operation<void> {
      const step = createStep('emit', type, payload, options?.layout ?? 'inline')
      trail.steps.push(step)

      // Emit to channel (platform can render it)
      yield* stepChannel.send({ step, respond: () => {} })
    },

    *prompt<TPayload, TResponse>(
      type: string,
      payload: TPayload,
      options?: { layout?: 'inline' | 'overlay' | 'fullscreen' }
    ): Operation<TResponse> {
      const step = createStep<TPayload>('prompt', type, payload, options?.layout ?? 'inline')
      trail.steps.push(step)

      // Create response signal
      const responseSignal = createSignal<TResponse, void>()

      // Subscribe BEFORE sending
      const subscription = yield* responseSignal

      // Emit to channel
      yield* stepChannel.send({
        step,
        respond: (response: TResponse) => {
          step.response = response
          step.status = 'complete'
          responseSignal.send(response)
        },
      })

      // Wait for response
      const { value } = yield* subscription.next()
      return value as TResponse
    },
  }
}

// =============================================================================
// STEP RUNNER
// =============================================================================

/**
 * Run a client generator and collect the execution trail.
 */
function* runClientGenerator<TResult>(
  callId: string,
  toolName: string,
  generator: (ctx: StepContext) => Operation<TResult>,
  stepChannel: Channel<PendingStep<any, any>, void>
): Operation<{ trail: ExecutionTrail; result: TResult }> {
  const trail: ExecutionTrail = {
    callId,
    toolName,
    steps: [],
    status: 'running',
    startedAt: Date.now(),
  }

  const ctx = createStepContext(callId, trail, stepChannel)

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
// EXAMPLE CLIENT GENERATORS
// =============================================================================

/**
 * Example: Card guessing with multiple steps
 */
function* cardGuessingClient(
  data: { choices: string[]; secret: string; hint: string },
  ctx: StepContext
): Operation<{ guess: string; correct: boolean }> {
  // Step 1: Show a hint (fire and forget)
  yield* ctx.emit('hint', {
    text: data.hint,
    style: 'mystical',
  })

  // Step 2: Let user pick a card (wait for response)
  const { selectedCard } = yield* ctx.prompt<
    { choices: string[]; prompt: string },
    { selectedCard: string }
  >('card-picker', {
    choices: data.choices,
    prompt: 'Which card am I thinking of?',
  })

  const correct = selectedCard === data.secret

  // Step 3: Show result (fire and forget)
  yield* ctx.emit('reveal', {
    secret: data.secret,
    guess: selectedCard,
    correct,
    message: correct ? 'Amazing! You got it!' : `Not quite. It was ${data.secret}`,
  })

  // Step 4: Celebration if correct
  if (correct) {
    yield* ctx.emit('celebration', {
      type: 'confetti',
      message: 'You have psychic powers!',
    })
  }

  // Return result for LLM
  return { guess: selectedCard, correct }
}

/**
 * Example: Multi-step wizard with conditional logic
 */
function* setupWizardClient(
  data: { options: string[] },
  ctx: StepContext
): Operation<{ config: Record<string, unknown> }> {
  // Step 1: Welcome
  yield* ctx.emit('welcome', {
    title: 'Setup Wizard',
    description: 'Let me help you configure your settings.',
  })

  // Step 2: Choose mode
  const { mode } = yield* ctx.prompt<
    { options: string[]; prompt: string },
    { mode: string }
  >('select', {
    options: data.options,
    prompt: 'Choose your mode:',
  })

  // Step 3: Mode-specific config
  let details: Record<string, unknown> = {}

  if (mode === 'Advanced') {
    // Advanced mode has more steps
    yield* ctx.emit('info', {
      message: 'Advanced mode unlocked! Let me ask a few more questions...',
    })

    const { enableFeatureX } = yield* ctx.prompt<
      { question: string },
      { enableFeatureX: boolean }
    >('yes-no', {
      question: 'Enable experimental Feature X?',
    })

    const { maxConnections } = yield* ctx.prompt<
      { prompt: string; min: number; max: number },
      { maxConnections: number }
    >('number-input', {
      prompt: 'Max connections:',
      min: 1,
      max: 100,
    })

    details = { enableFeatureX, maxConnections }
  }

  // Step 4: Confirmation
  yield* ctx.emit('summary', {
    mode,
    details,
    message: 'Configuration complete!',
  })

  return { config: { mode, ...details } }
}

/**
 * Example: Streaming progress with updates
 */
function* fileUploadClient(
  data: { files: string[] },
  ctx: StepContext
): Operation<{ uploaded: string[] }> {
  const uploaded: string[] = []

  for (const file of data.files) {
    // Show progress for each file
    yield* ctx.emit('upload-progress', {
      file,
      status: 'uploading',
      progress: 0,
    })

    // Simulate upload time (in real code, this would be actual upload)
    // For demo, we just mark it as complete
    uploaded.push(file)

    yield* ctx.emit('upload-progress', {
      file,
      status: 'complete',
      progress: 100,
    })
  }

  yield* ctx.emit('upload-complete', {
    count: uploaded.length,
    files: uploaded,
  })

  return { uploaded }
}

// =============================================================================
// PLATFORM SIMULATOR
// =============================================================================

/**
 * Simulates a platform (React, terminal, etc.) that handles steps.
 */
interface PlatformSimulator {
  /** Handlers for different step types */
  handlers: Map<string, (payload: any) => any>
  /** Rendered steps (what the UI would show) */
  rendered: Step[]
  /** Process a pending step */
  handle: (pending: PendingStep) => void
}

function createPlatformSimulator(): PlatformSimulator {
  const handlers = new Map<string, (payload: any) => any>()
  const rendered: Step[] = []

  return {
    handlers,
    rendered,
    handle(pending) {
      // Always add to rendered list (platform would render it)
      rendered.push(pending.step)

      // If it's a prompt, we need to respond
      if (pending.step.kind === 'prompt') {
        const handler = handlers.get(pending.step.type)
        if (handler) {
          const response = handler(pending.step.payload)
          pending.respond(response)
        } else {
          throw new Error(`No handler for prompt type: ${pending.step.type}`)
        }
      }
    },
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Streaming Steps - Client Tools as Chat Participants', () => {
  describe('Basic step emission', () => {
    it('should emit steps and record them in the trail', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createPlatformSimulator()

        // Set up handlers
        platform.handlers.set('card-picker', (payload) => ({
          selectedCard: payload.choices[0],
        }))

        // Spawn platform handler
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        // Run the client generator
        const { trail, result: clientResult } = yield* runClientGenerator(
          'call-1',
          'guess_card',
          (ctx) => cardGuessingClient(
            { choices: ['Ace of Spades', 'King of Hearts'], secret: 'Ace of Spades', hint: 'It\'s black...' },
            ctx
          ),
          channel
        )

        yield* sleep(50)

        return { trail, clientResult, rendered: platform.rendered }
      })

      // Check the trail
      expect(result.trail.callId).toBe('call-1')
      expect(result.trail.toolName).toBe('guess_card')
      expect(result.trail.status).toBe('complete')
      expect(result.trail.steps).toHaveLength(4) // hint, card-picker, reveal, celebration

      // Check step types and kinds
      expect(result.trail.steps[0]).toMatchObject({
        type: 'hint',
        kind: 'emit',
        status: 'complete',
      })
      expect(result.trail.steps[1]).toMatchObject({
        type: 'card-picker',
        kind: 'prompt',
        status: 'complete',
        response: { selectedCard: 'Ace of Spades' },
      })
      expect(result.trail.steps[2]).toMatchObject({
        type: 'reveal',
        kind: 'emit',
      })
      expect(result.trail.steps[3]).toMatchObject({
        type: 'celebration',
        kind: 'emit',
      })

      // Check final result
      expect(result.clientResult).toEqual({
        guess: 'Ace of Spades',
        correct: true,
      })

      // Platform should have rendered all steps
      expect(result.rendered).toHaveLength(4)
    })

    it('should handle incorrect guess (no celebration step)', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createPlatformSimulator()

        platform.handlers.set('card-picker', () => ({
          selectedCard: 'King of Hearts', // Wrong guess
        }))

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: clientResult } = yield* runClientGenerator(
          'call-2',
          'guess_card',
          (ctx) => cardGuessingClient(
            { choices: ['Ace of Spades', 'King of Hearts'], secret: 'Ace of Spades', hint: 'It\'s black...' },
            ctx
          ),
          channel
        )

        yield* sleep(50)

        return { trail, clientResult }
      })

      // No celebration when wrong
      expect(result.trail.steps).toHaveLength(3) // hint, card-picker, reveal (no celebration)
      expect(result.clientResult).toEqual({
        guess: 'King of Hearts',
        correct: false,
      })
    })
  })

  describe('Multi-step wizard with conditional logic', () => {
    it('should handle basic mode (fewer steps)', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createPlatformSimulator()

        platform.handlers.set('select', () => ({ mode: 'Basic' }))

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: clientResult } = yield* runClientGenerator(
          'call-3',
          'setup_wizard',
          (ctx) => setupWizardClient({ options: ['Basic', 'Advanced'] }, ctx),
          channel
        )

        yield* sleep(50)

        return { trail, clientResult }
      })

      // Basic mode: welcome, select, summary (3 steps)
      expect(result.trail.steps).toHaveLength(3)
      expect(result.trail.steps.map(s => s.type)).toEqual(['welcome', 'select', 'summary'])
      expect(result.clientResult).toEqual({ config: { mode: 'Basic' } })
    })

    it('should handle advanced mode (more steps)', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createPlatformSimulator()

        platform.handlers.set('select', () => ({ mode: 'Advanced' }))
        platform.handlers.set('yes-no', () => ({ enableFeatureX: true }))
        platform.handlers.set('number-input', () => ({ maxConnections: 50 }))

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: clientResult } = yield* runClientGenerator(
          'call-4',
          'setup_wizard',
          (ctx) => setupWizardClient({ options: ['Basic', 'Advanced'] }, ctx),
          channel
        )

        yield* sleep(50)

        return { trail, clientResult }
      })

      // Advanced mode: welcome, select, info, yes-no, number-input, summary (6 steps)
      expect(result.trail.steps).toHaveLength(6)
      expect(result.trail.steps.map(s => s.type)).toEqual([
        'welcome',
        'select',
        'info',
        'yes-no',
        'number-input',
        'summary',
      ])
      expect(result.clientResult).toEqual({
        config: {
          mode: 'Advanced',
          enableFeatureX: true,
          maxConnections: 50,
        },
      })
    })
  })

  describe('Streaming progress', () => {
    it('should emit multiple progress steps', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createPlatformSimulator()

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: clientResult } = yield* runClientGenerator(
          'call-5',
          'file_upload',
          (ctx) => fileUploadClient({ files: ['a.txt', 'b.txt', 'c.txt'] }, ctx),
          channel
        )

        yield* sleep(50)

        return { trail, clientResult }
      })

      // 3 files × 2 progress steps each + 1 complete = 7 steps
      expect(result.trail.steps).toHaveLength(7)

      // All should be emit (no prompts)
      expect(result.trail.steps.every(s => s.kind === 'emit')).toBe(true)

      // Check progress pattern
      const progressSteps = result.trail.steps.filter(s => s.type === 'upload-progress')
      expect(progressSteps).toHaveLength(6)

      expect(result.clientResult).toEqual({
        uploaded: ['a.txt', 'b.txt', 'c.txt'],
      })
    })
  })

  describe('Trail as renderable history', () => {
    it('should produce a trail that can be rendered like messages', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createPlatformSimulator()

        platform.handlers.set('card-picker', (payload) => ({
          selectedCard: payload.choices[1],
        }))

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            platform.handle(pending)
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail } = yield* runClientGenerator(
          'call-6',
          'guess_card',
          (ctx) => cardGuessingClient(
            { choices: ['A', 'B'], secret: 'A', hint: 'First letter...' },
            ctx
          ),
          channel
        )

        yield* sleep(50)

        return trail
      })

      // The trail can be mapped to UI just like messages
      const renderableItems = result.steps.map(step => ({
        id: step.id,
        type: step.type,
        content: step.payload,
        isInteractive: step.kind === 'prompt',
        response: step.response,
      }))

      expect(renderableItems).toHaveLength(3)
      expect(renderableItems[0]).toMatchObject({
        type: 'hint',
        isInteractive: false,
      })
      expect(renderableItems[1]).toMatchObject({
        type: 'card-picker',
        isInteractive: true,
        response: { selectedCard: 'B' },
      })
      expect(renderableItems[2]).toMatchObject({
        type: 'reveal',
        isInteractive: false,
      })
    })
  })
})

// =============================================================================
// DESIGN NOTES
// =============================================================================

/**
 * ## What This Proves
 *
 * 1. **Steps as first-class entities**: Each yield creates a recordable step
 * 2. **Trail as history**: The execution trail is like a message history for tools
 * 3. **Conditional complexity**: Advanced flows can have more/fewer steps
 * 4. **Streaming updates**: Progress can be emitted as multiple steps
 * 5. **Render-ready**: Trail steps can be mapped to UI just like messages
 *
 * ## React Integration Vision
 *
 * ```tsx
 * function ChatStream({ messages, toolExecutions }) {
 *   const timeline = mergeByTimestamp(messages, toolExecutions)
 *
 *   return timeline.map(item => {
 *     if (item.type === 'message') {
 *       return <MessageBubble message={item} />
 *     }
 *
 *     if (item.type === 'tool-execution') {
 *       return (
 *         <ToolExecution execution={item}>
 *           {item.trail.steps.map(step => (
 *             <StepRenderer
 *               key={step.id}
 *               step={step}
 *               onRespond={response => handleStepResponse(step.id, response)}
 *             />
 *           ))}
 *         </ToolExecution>
 *       )
 *     }
 *   })
 * }
 *
 * // Step renderer dispatches to type-specific components
 * function StepRenderer({ step, onRespond }) {
 *   const Component = stepComponents[step.type]
 *   if (!Component) return <UnknownStep step={step} />
 *
 *   return (
 *     <Component
 *       payload={step.payload}
 *       response={step.response}
 *       onRespond={step.kind === 'prompt' ? onRespond : undefined}
 *     />
 *   )
 * }
 * ```
 *
 * ## Next Steps
 *
 * 1. **Layout hints**: Test inline vs overlay rendering decisions
 * 2. **Cancellation**: What happens when execution is halted mid-step?
 * 3. **Serialization**: Can we save/restore the trail for session persistence?
 * 4. **Composability**: Sub-generators that yield their own steps
 * 5. **Type safety**: Stronger typing for step type → payload/response mapping
 */
