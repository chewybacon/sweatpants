/**
 * Terminal Simulator - Exploring UI-Agnostic Client Handoffs
 *
 * This test file explores a new design for client-side tool execution:
 *
 * 1. Tools yield control via `ctx.waitFor()` - a platform-agnostic primitive
 * 2. Platform handlers (terminal, React, etc.) provide the responses
 * 3. The generator resumes with typed responses
 *
 * Goals:
 * - Framework-agnostic: Same tool works with React, terminal, or any UI
 * - Type-safe: Response types flow through the yield boundary
 * - Composable: Multiple yields for multi-step interactions
 * - Effection-native: Cancellation, structured concurrency work naturally
 */
import { describe, it, expect } from 'vitest'
import { run, createSignal, createChannel, spawn, each, sleep, type Operation, type Channel } from 'effection'

// =============================================================================
// CORE PRIMITIVES
// =============================================================================

/**
 * A UI request that the client generator yields to wait for user input.
 *
 * The generator yields this, suspends, and resumes when a response arrives.
 */
interface UIRequest<TPayload = unknown, TResponse = unknown> {
  /** Unique ID for this request */
  id: string
  /** Type tag for routing to handlers */
  type: string
  /** Data the UI needs to render */
  payload: TPayload
  /** Phantom type for response - not used at runtime */
  _responseType?: TResponse
}

/**
 * A pending UI request exposed to the platform layer.
 */
interface PendingUIRequest<TPayload = unknown, TResponse = unknown> {
  /** The request details */
  request: UIRequest<TPayload, TResponse>
  /** Call this to provide the response and resume the generator */
  respond: (response: TResponse) => void
}

/**
 * Client context passed to tool's client generator.
 */
interface ClientContext {
  /**
   * Yield control to wait for UI input.
   *
   * The generator suspends until a response is provided.
   *
   * @param type - Type tag for routing (e.g., 'select-choice', 'yes-no')
   * @param payload - Data the UI needs
   * @returns The response from the UI
   */
  waitFor<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

// =============================================================================
// CLIENT RUNTIME
// =============================================================================

/**
 * Creates a client context that emits UI requests to a channel.
 */
function createClientContext(
  requestChannel: Channel<PendingUIRequest<any, any>, void>
): ClientContext {
  let requestId = 0

  return {
    *waitFor<TPayload, TResponse>(
      type: string,
      payload: TPayload
    ): Operation<TResponse> {
      const id = `req-${++requestId}`

      // Create a signal for the response
      const responseSignal = createSignal<TResponse, void>()

      // IMPORTANT: Subscribe to the signal BEFORE sending to the channel
      // This prevents the race condition where the handler responds before we're listening
      const subscription = yield* responseSignal

      // Create the pending request
      const pending: PendingUIRequest<TPayload, TResponse> = {
        request: { id, type, payload },
        respond: (response) => responseSignal.send(response),
      }

      // Emit to channel for platform layer to pick up
      yield* requestChannel.send(pending)

      // Now wait for the response
      const { value } = yield* subscription.next()
      return value as TResponse
    },
  }
}

// =============================================================================
// TERMINAL SIMULATOR
// =============================================================================

/**
 * Simulated terminal that auto-responds to UI requests.
 *
 * In a real terminal app, this would use readline/inquirer/etc.
 */
interface TerminalSimulator {
  /** Responses to provide for each request type */
  responses: Map<string, (payload: any) => any>
  /** Log of requests received */
  log: Array<{ type: string; payload: any }>
  /** Process a pending request */
  handle: (pending: PendingUIRequest) => void
}

function createTerminalSimulator(): TerminalSimulator {
  const responses = new Map<string, (payload: any) => any>()
  const log: Array<{ type: string; payload: any }> = []

  return {
    responses,
    log,
    handle(pending) {
      log.push({ type: pending.request.type, payload: pending.request.payload })
      const handler = responses.get(pending.request.type)
      if (handler) {
        const response = handler(pending.request.payload)
        pending.respond(response)
      } else {
        throw new Error(`No terminal handler for request type: ${pending.request.type}`)
      }
    },
  }
}

// =============================================================================
// EXAMPLE TOOL DEFINITIONS (V2 - with waitFor)
// =============================================================================

/**
 * Example: A simple choice selection tool
 */
interface SelectChoicePayload {
  prompt: string
  choices: string[]
}

interface SelectChoiceResponse {
  selectedChoice: string
}

function* selectChoiceClient(
  data: { choices: string[]; prompt: string },
  ctx: ClientContext
): Operation<SelectChoiceResponse> {
  const response = yield* ctx.waitFor<SelectChoicePayload, SelectChoiceResponse>(
    'select-choice',
    { prompt: data.prompt, choices: data.choices }
  )
  return response
}

/**
 * Example: A yes/no question tool
 */
interface YesNoPayload {
  question: string
}

interface YesNoResponse {
  answer: boolean
}

function* yesNoClient(
  data: { question: string },
  ctx: ClientContext
): Operation<YesNoResponse> {
  const response = yield* ctx.waitFor<YesNoPayload, YesNoResponse>(
    'yes-no',
    { question: data.question }
  )
  return response
}

/**
 * Example: Multi-step wizard
 */
interface WizardStep1Payload {
  title: string
  options: string[]
}

interface WizardStep1Response {
  selectedOption: string
}

interface WizardStep2Payload {
  selectedOption: string
  detailsPrompt: string
}

interface WizardStep2Response {
  details: string
}

function* multiStepWizardClient(
  data: { title: string; options: string[] },
  ctx: ClientContext
): Operation<{ option: string; details: string }> {
  // Step 1: Select an option
  const step1 = yield* ctx.waitFor<WizardStep1Payload, WizardStep1Response>(
    'wizard-step-1',
    { title: data.title, options: data.options }
  )

  // Step 2: Get details based on selection
  const step2 = yield* ctx.waitFor<WizardStep2Payload, WizardStep2Response>(
    'wizard-step-2',
    { selectedOption: step1.selectedOption, detailsPrompt: `Enter details for ${step1.selectedOption}:` }
  )

  return { option: step1.selectedOption, details: step2.details }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Terminal Simulator - UI-Agnostic Client Handoffs', () => {
  describe('Basic waitFor flow', () => {
    it('should suspend generator and resume with response', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingUIRequest>()
        const ctx = createClientContext(channel)
        const terminal = createTerminalSimulator()

        // Set up terminal to auto-respond
        terminal.responses.set('select-choice', (payload: SelectChoicePayload) => ({
          selectedChoice: payload.choices[0], // Always pick first
        }))

        // Store result here
        let clientResult: SelectChoiceResponse | undefined

        // Spawn the request handler - runs concurrently, processing requests as they arrive
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            terminal.handle(pending)
            yield* each.next()
          }
        })

        // Give the handler a moment to start listening
        yield* sleep(1)

        // Spawn the client generator
        yield* spawn(function* () {
          clientResult = yield* selectChoiceClient(
            { choices: ['A', 'B', 'C'], prompt: 'Pick one' },
            ctx
          )
        })

        // Give spawned tasks time to run
        yield* sleep(50)

        return { result: clientResult, log: terminal.log }
      })

      expect(result.result).toEqual({ selectedChoice: 'A' })
      expect(result.log).toEqual([
        { type: 'select-choice', payload: { prompt: 'Pick one', choices: ['A', 'B', 'C'] } },
      ])
    })

    it('should handle yes/no questions', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingUIRequest>()
        const ctx = createClientContext(channel)
        const terminal = createTerminalSimulator()

        terminal.responses.set('yes-no', () => ({ answer: true }))

        let clientResult: YesNoResponse | undefined

        // Spawn handler first
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            terminal.handle(pending)
            yield* each.next()
          }
        })

        // Give the handler a moment to start listening
        yield* sleep(1)

        // Then spawn client
        yield* spawn(function* () {
          clientResult = yield* yesNoClient({ question: 'Continue?' }, ctx)
        })

        yield* sleep(50)

        return clientResult
      })

      expect(result).toEqual({ answer: true })
    })
  })

  describe('Multi-step flows', () => {
    it('should handle multiple yields in sequence', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingUIRequest>()
        const ctx = createClientContext(channel)
        const terminal = createTerminalSimulator()

        // Set up responses for each step
        terminal.responses.set('wizard-step-1', (payload: WizardStep1Payload) => ({
          selectedOption: payload.options[1], // Pick second option
        }))
        terminal.responses.set('wizard-step-2', (payload: WizardStep2Payload) => ({
          details: `Details for ${payload.selectedOption}`,
        }))

        let clientResult: { option: string; details: string } | undefined

        // Track requests as they come in for assertions
        const requestTypes: string[] = []
        const step2Payloads: WizardStep2Payload[] = []

        // Spawn handler
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            requestTypes.push(pending.request.type)
            if (pending.request.type === 'wizard-step-2') {
              step2Payloads.push(pending.request.payload as WizardStep2Payload)
            }
            terminal.handle(pending)
            yield* each.next()
          }
        })

        // Give the handler a moment to start listening
        yield* sleep(1)

        // Spawn client
        yield* spawn(function* () {
          clientResult = yield* multiStepWizardClient(
            { title: 'Setup Wizard', options: ['Basic', 'Advanced', 'Custom'] },
            ctx
          )
        })

        yield* sleep(100)

        return { result: clientResult, log: terminal.log, requestTypes, step2Payloads }
      })

      expect(result.result).toEqual({
        option: 'Advanced',
        details: 'Details for Advanced',
      })
      expect(result.log).toHaveLength(2)
      expect(result.requestTypes).toEqual(['wizard-step-1', 'wizard-step-2'])
      expect(result.step2Payloads[0]?.selectedOption).toBe('Advanced')
    })
  })

  describe('Type safety', () => {
    it('should preserve types through waitFor', async () => {
      await run(function* () {
        const channel = createChannel<PendingUIRequest>()
        const ctx = createClientContext(channel)

        // This is a compile-time check - if types are wrong, TS errors
        function* typedClient(_ctx: ClientContext): Operation<{ name: string; age: number }> {
          const nameResponse = yield* _ctx.waitFor<{ prompt: string }, { value: string }>(
            'text-input',
            { prompt: 'Enter name' }
          )

          const ageResponse = yield* _ctx.waitFor<{ prompt: string; min: number }, { value: number }>(
            'number-input',
            { prompt: 'Enter age', min: 0 }
          )

          // Types are preserved!
          return {
            name: nameResponse.value, // string
            age: ageResponse.value,   // number
          }
        }

        // Just verify it compiles - the types flow correctly
        expect(typedClient).toBeDefined()
        // Use ctx to avoid unused variable warning
        expect(ctx).toBeDefined()
      })
    })
  })

  describe('Error handling', () => {
    it('should throw if no handler registered', async () => {
      let errorThrown = false
      let errorMessage = ''

      await run(function* () {
        const channel = createChannel<PendingUIRequest>()
        const ctx = createClientContext(channel)
        const terminal = createTerminalSimulator()
        // Note: NOT registering a handler for 'yes-no'

        // Spawn handler that will throw
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            try {
              terminal.handle(pending)
            } catch (e) {
              errorThrown = true
              errorMessage = (e as Error).message
            }
            yield* each.next()
          }
        })

        // Give the handler a moment to start listening
        yield* sleep(1)

        // Spawn client
        yield* spawn(function* () {
          yield* yesNoClient({ question: 'Will this fail?' }, ctx)
        })

        yield* sleep(50)
      })

      expect(errorThrown).toBe(true)
      expect(errorMessage).toBe('No terminal handler for request type: yes-no')
    })
  })
})

// =============================================================================
// DESIGN NOTES
// =============================================================================

/**
 * ## What We've Proven
 *
 * 1. `ctx.waitFor(type, payload)` works as a suspension primitive
 * 2. Platform handlers (terminal sim) can respond and resume generators
 * 3. Multi-step flows work naturally with multiple yields
 * 4. Types flow through the yield boundary
 *
 * ## Next Steps
 *
 * 1. Integrate this into the real tool builder:
 *    ```typescript
 *    const tool = createIsomorphicTool('select_choice')
 *      .client(function*(data, ctx) {
 *        const response = yield* ctx.waitFor('select-choice', {
 *          choices: data.choices,
 *          prompt: data.prompt,
 *        })
 *        return { selected: response.choice }
 *      })
 *    ```
 *
 * 2. Create handler registries for different platforms:
 *    - React: `createReactHandlers().add('select-choice', (payload, respond) => <UI />)`
 *    - Terminal: `createTerminalHandlers().add('select-choice', async (payload) => readline())`
 *
 * 3. Wire into useChatSession:
 *    - `pendingUIRequests` instead of `pendingHandoffs`
 *    - Platform handlers render based on request type
 *
 * 4. Consider typed request/response schemas:
 *    ```typescript
 *    const SelectChoice = defineUIRequest({
 *      type: 'select-choice',
 *      payload: z.object({ prompt: z.string(), choices: z.array(z.string()) }),
 *      response: z.object({ selectedChoice: z.string() }),
 *    })
 *
 *    // In tool:
 *    const response = yield* ctx.waitFor(SelectChoice, { prompt, choices })
 *    // response is typed as { selectedChoice: string }
 *    ```
 *
 * ## Open Questions
 *
 * 1. How do we type the handler registry? Each platform needs to handle the same types.
 * 2. Should we support streaming responses? (e.g., real-time form validation)
 * 3. How does cancellation propagate? (user navigates away mid-wizard)
 * 4. Should request types be strings or symbols/objects for better type inference?
 */
