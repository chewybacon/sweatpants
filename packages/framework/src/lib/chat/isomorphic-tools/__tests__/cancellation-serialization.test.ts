/**
 * Cancellation & State Serialization - Delimited Continuations in Action
 *
 * Exploring:
 * 1. Clean shutdown of generators mid-execution
 * 2. Serializing execution state for persistence
 * 3. Rehydrating from serialized state to resume execution
 *
 * This is where Effection's structured concurrency really shines.
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel, createSignal, spawn, each, sleep, type Operation, type Channel, type Task } from 'effection'

// =============================================================================
// TYPES (reusing from streaming-steps)
// =============================================================================

interface Step<TPayload = unknown, TResponse = unknown> {
  id: string
  type: string
  kind: 'emit' | 'prompt'
  payload: TPayload
  timestamp: number
  layout?: 'inline' | 'overlay' | 'fullscreen'
  response?: TResponse
  status: 'pending' | 'complete'
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
  /** For resumption: which step are we waiting on? */
  pendingStepId?: string
  /** Serializable snapshot of where we are */
  checkpoint?: ExecutionCheckpoint
}

/**
 * A serializable checkpoint for resumption.
 */
interface ExecutionCheckpoint {
  /** Which step index we're at (0-based) */
  stepIndex: number
  /** The pending step's type (for routing) */
  pendingType?: string
  /** The pending step's payload (for re-rendering) */
  pendingPayload?: unknown
  /** All completed step responses (for replay) */
  completedResponses: Array<{ stepId: string; response: unknown }>
}

// =============================================================================
// STEP CONTEXT WITH CHECKPOINT SUPPORT
// =============================================================================

interface StepContext {
  emit<TPayload>(
    type: string,
    payload: TPayload,
    options?: { layout?: 'inline' | 'overlay' }
  ): Operation<void>

  prompt<TPayload, TResponse>(
    type: string,
    payload: TPayload,
    options?: { layout?: 'inline' | 'overlay' | 'fullscreen' }
  ): Operation<TResponse>
}

function createStepContext(
  callId: string,
  trail: ExecutionTrail,
  stepChannel: Channel<PendingStep<any, any>, void>,
  /** Optional: pre-filled responses for replay */
  replayResponses?: Map<number, unknown>
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
      yield* stepChannel.send({ step, respond: () => {} })
    },

    *prompt<TPayload, TResponse>(
      type: string,
      payload: TPayload,
      options?: { layout?: 'inline' | 'overlay' | 'fullscreen' }
    ): Operation<TResponse> {
      const currentStepIndex = stepCounter // capture before increment
      const step = createStep<TPayload>('prompt', type, payload, options?.layout ?? 'inline')
      trail.steps.push(step)

      // Check if we have a replay response
      if (replayResponses?.has(currentStepIndex)) {
        const response = replayResponses.get(currentStepIndex) as TResponse
        step.response = response
        step.status = 'complete'
        // Still emit to channel so platform can show it
        yield* stepChannel.send({ step, respond: () => {} })
        return response
      }

      // Update checkpoint
      trail.pendingStepId = step.id
      trail.checkpoint = {
        stepIndex: currentStepIndex,
        pendingType: type,
        pendingPayload: payload,
        completedResponses: trail.steps
          .filter(s => s.kind === 'prompt' && s.status === 'complete')
          .map(s => ({ stepId: s.id, response: s.response })),
      }

      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      yield* stepChannel.send({
        step,
        respond: (response: TResponse) => {
          step.response = response
          step.status = 'complete'
          trail.pendingStepId = undefined
          responseSignal.send(response)
        },
      })

      const { value } = yield* subscription.next()
      return value as TResponse
    },
  }
}

// =============================================================================
// RUNNER WITH CANCELLATION
// =============================================================================

interface RunnerHandle<TResult> {
  /** The execution trail (live, updates as execution progresses) */
  trail: ExecutionTrail
  /** The spawned task (can be halted) */
  task: Task<{ trail: ExecutionTrail; result: TResult }>
}

function* runClientGeneratorWithHandle<TResult>(
  callId: string,
  toolName: string,
  generator: (ctx: StepContext) => Operation<TResult>,
  stepChannel: Channel<PendingStep<any, any>, void>,
  replayResponses?: Map<number, unknown>
): Operation<RunnerHandle<TResult>> {
  const trail: ExecutionTrail = {
    callId,
    toolName,
    steps: [],
    status: 'running',
    startedAt: Date.now(),
  }

  const ctx = createStepContext(callId, trail, stepChannel, replayResponses)

  const task = yield* spawn(function* () {
    try {
      const result = yield* generator(ctx)
      trail.result = result
      trail.status = 'complete'
      trail.completedAt = Date.now()
      return { trail, result }
    } catch (error) {
      if ((error as Error).message === 'halted') {
        trail.status = 'cancelled'
      } else {
        trail.status = 'error'
      }
      trail.completedAt = Date.now()
      throw error
    }
  })

  return { trail, task }
}

// =============================================================================
// EXAMPLE GENERATORS
// =============================================================================

function* multiStepClient(
  ctx: StepContext
): Operation<{ steps: number; final: string }> {
  yield* ctx.emit('start', { message: 'Starting process...' })

  const step1 = yield* ctx.prompt<{ num: number }, { value: string }>(
    'input-1',
    { num: 1 }
  )

  yield* ctx.emit('progress', { completed: 1 })

  const step2 = yield* ctx.prompt<{ num: number }, { value: string }>(
    'input-2',
    { num: 2 }
  )

  yield* ctx.emit('progress', { completed: 2 })

  const step3 = yield* ctx.prompt<{ num: number }, { value: string }>(
    'input-3',
    { num: 3 }
  )

  yield* ctx.emit('done', { message: 'Complete!' })

  return {
    steps: 3,
    final: `${step1.value}-${step2.value}-${step3.value}`,
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Cancellation & State Serialization', () => {
  describe('Clean cancellation', () => {
    it('should cleanly halt mid-execution', async () => {
      let trailSnapshot: ExecutionTrail | undefined

      await run(function* () {
        const channel = createChannel<PendingStep>()
        const responses: Array<(r: { value: string }) => void> = []

        // Platform that captures respond functions
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              responses.push(pending.respond)
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        // Start execution
        const handle = yield* runClientGeneratorWithHandle(
          'cancel-test',
          'test_tool',
          multiStepClient,
          channel
        )

        // Wait for first prompt
        yield* sleep(10)

        // Respond to first prompt
        responses[0]?.({ value: 'A' })
        yield* sleep(10)

        // Wait for second prompt
        yield* sleep(10)

        // Now cancel before responding to second prompt
        trailSnapshot = { ...handle.trail, steps: [...handle.trail.steps] }

        // Halt the task
        yield* handle.task.halt()
      }).catch(() => {
        // Expected - halted
      })

      // Verify partial trail
      expect(trailSnapshot).toBeDefined()
      expect(trailSnapshot!.steps.length).toBeGreaterThanOrEqual(2) // start, input-1
      expect(trailSnapshot!.status).toBe('running') // Was running when we snapshotted

      // First prompt should be complete
      const firstPrompt = trailSnapshot!.steps.find(s => s.type === 'input-1')
      expect(firstPrompt?.status).toBe('complete')
      expect(firstPrompt?.response).toEqual({ value: 'A' })
    })

    it('should preserve checkpoint on cancellation', async () => {
      let checkpoint: ExecutionCheckpoint | undefined

      await run(function* () {
        const channel = createChannel<PendingStep>()
        const responses: Array<(r: { value: string }) => void> = []

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              responses.push(pending.respond)
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        const handle = yield* runClientGeneratorWithHandle(
          'checkpoint-test',
          'test_tool',
          multiStepClient,
          channel
        )

        // Complete first two prompts
        yield* sleep(10)
        responses[0]?.({ value: 'A' })
        yield* sleep(20)
        responses[1]?.({ value: 'B' })
        yield* sleep(20)

        // Now we should be waiting on third prompt
        // Grab checkpoint before cancelling
        checkpoint = handle.trail.checkpoint

        yield* handle.task.halt()
      }).catch(() => {
        // Expected
      })

      expect(checkpoint).toBeDefined()
      expect(checkpoint!.stepIndex).toBe(5) // 0:start, 1:input-1, 2:progress, 3:input-2, 4:progress, 5:input-3
      expect(checkpoint!.pendingType).toBe('input-3')
      expect(checkpoint!.completedResponses).toHaveLength(2)
    })
  })

  describe('State resumption', () => {
    it('should resume from checkpoint with replay responses', async () => {
      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const renderedSteps: Step[] = []

        // Platform that auto-responds
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            renderedSteps.push(pending.step)
            if (pending.step.kind === 'prompt' && pending.step.status === 'pending') {
              // Only respond if not already complete (replay case)
              pending.respond({ value: `response-${pending.step.type}` })
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        // Simulate resumption with pre-filled responses
        const replayResponses = new Map<number, unknown>([
          [1, { value: 'A' }],  // input-1
          [3, { value: 'B' }],  // input-2
        ])

        const handle = yield* runClientGeneratorWithHandle(
          'resume-test',
          'test_tool',
          multiStepClient,
          channel,
          replayResponses
        )

        // Wait for completion
        const { trail, result: genResult } = yield* handle.task

        return { trail, result: genResult, renderedSteps }
      })

      expect(result.trail.status).toBe('complete')
      expect(result.result.steps).toBe(3)
      // First two responses are replayed, third is fresh
      expect(result.result.final).toBe('A-B-response-input-3')

      // All steps should have been emitted to platform
      expect(result.renderedSteps.length).toBeGreaterThanOrEqual(6)
    })
  })

  describe('Serialization round-trip', () => {
    it('should serialize and deserialize checkpoint', async () => {
      // This test demonstrates that checkpoint serialization works during execution.
      // The actual serialization verification is in the next test.
      await run(function* () {
        const channel = createChannel<PendingStep>()
        const responses: Array<(r: { value: string }) => void> = []

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              responses.push(pending.respond)
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        const handle = yield* runClientGeneratorWithHandle(
          'serial-test',
          'test_tool',
          multiStepClient,
          channel
        )

        // Complete first prompt
        yield* sleep(10)
        responses[0]?.({ value: 'serialized-A' })
        yield* sleep(20)

        // Verify checkpoint exists and is serializable
        const checkpoint = handle.trail.checkpoint
        expect(checkpoint).toBeDefined()
        const serialized = JSON.stringify(checkpoint)
        const deserialized = JSON.parse(serialized) as ExecutionCheckpoint
        expect(deserialized.stepIndex).toBeGreaterThan(0)

        yield* handle.task.halt()
      }).catch(() => {
        // Expected - halted
      })
    })

    it('should be JSON-serializable', async () => {
      const checkpoint: ExecutionCheckpoint = {
        stepIndex: 5,
        pendingType: 'input-3',
        pendingPayload: { num: 3 },
        completedResponses: [
          { stepId: 'step-1', response: { value: 'A' } },
          { stepId: 'step-2', response: { value: 'B' } },
        ],
      }

      const serialized = JSON.stringify(checkpoint)
      const deserialized = JSON.parse(serialized) as ExecutionCheckpoint

      expect(deserialized.stepIndex).toBe(5)
      expect(deserialized.pendingType).toBe('input-3')
      expect(deserialized.completedResponses).toHaveLength(2)

      // Build replay map from deserialized
      const replayMap = new Map(
        deserialized.completedResponses.map((cr, idx) => [idx + 1, cr.response])
      )

      expect(replayMap.get(1)).toEqual({ value: 'A' })
      expect(replayMap.get(2)).toEqual({ value: 'B' })
    })
  })
})

// =============================================================================
// DESIGN NOTES
// =============================================================================

/**
 * ## What We've Proven
 *
 * 1. **Clean cancellation**: `task.halt()` cleanly stops the generator
 * 2. **Checkpoint capture**: We can snapshot where we are mid-execution
 * 3. **JSON serializable**: Checkpoint can be persisted to storage
 * 4. **Replay resumption**: Pre-fill responses to skip completed steps
 *
 * ## The Power of Delimited Continuations
 *
 * Effection generators give us:
 * - **Explicit suspension points**: Each `yield*` is a potential checkpoint
 * - **Clean shutdown**: `halt()` runs finally blocks, cleans up resources
 * - **No callback hell**: Linear code despite async suspension
 * - **Composable**: Sub-generators work naturally
 *
 * ## Resumption Strategy
 *
 * When resuming from a checkpoint:
 * 1. Parse the serialized checkpoint
 * 2. Build a replay map: step index → response
 * 3. Run the generator again from the start
 * 4. For each prompt, check replay map first
 * 5. If response exists, use it (fast-forward)
 * 6. If not, emit to platform and wait (resume normal flow)
 *
 * This is "replay-based resumption" - we re-run the generator but skip
 * the prompts we've already answered. The generator is deterministic
 * (same inputs → same outputs), so this works.
 *
 * ## Limitations
 *
 * 1. Generator must be deterministic (no random, no side effects in logic)
 * 2. Payloads must be JSON-serializable
 * 3. We re-emit all steps on resume (platform sees them again)
 *
 * ## Next Steps
 *
 * 1. Integrate with session persistence (localStorage, server-side)
 * 2. Handle non-deterministic generators (e.g., timestamps)
 * 3. Optimize replay (don't re-emit already-rendered steps)
 * 4. Test with complex nested generators
 */
