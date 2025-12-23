/**
 * two-phase-continuation.test.ts
 *
 * HISTORICAL: This file documents the exploration of V5-V7 continuation patterns.
 * The final chosen pattern is V7 (handoff with before/after), which is now
 * implemented in the executor and tested in v7-handoff-executor.test.ts.
 *
 * ## Patterns Explored
 *
 * V5: beforeClient / afterClient - Explicit two-phase API
 *     Problem: Code between the two calls runs in BOTH phases
 *
 * V6: Various approaches to avoid running "between" code twice
 *     - Approach 1: Context exposes current phase (ctx.phase)
 *     - Approach 2: Single handoff() with before/after callbacks ← CHOSEN
 *     - Approach 3: Chained API (beforeClient returns afterClient)
 *
 * V7: handoff({ before, after }) - The final API
 *     - before() runs only in phase 1
 *     - after() runs only in phase 2 with cached handoff + client response
 *     - No "between" code possible - everything in callbacks
 *
 * ## Key Insight
 *
 * The V7 pattern eliminates the "between code" problem entirely by putting
 * all phase-specific code inside callbacks. This is the cleanest API and
 * provides true idempotency for expensive computations.
 *
 * ## Documented Limitation
 *
 * Only ONE handoff() call per tool execution is supported. Multiple handoffs
 * would require tracking which handoff index we're resuming.
 *
 * ## Original Description
 *
 * Exploring a two-phase explicit API for server-authority tools.
 *
 * The idea: Instead of one block with a magic `send()` point, we have
 * two explicit operations: `beforeClient` and `afterClient`.
 *
 * ```typescript
 * function* server(params, ctx) {
 *   const handoff = yield* ctx.beforeClient(function* () {
 *     const secret = pickRandomCard()
 *     return { secret, hint: 'Guess!' }
 *   })
 *
 *   const result = yield* ctx.afterClient(function* (clientResult) {
 *     return {
 *       secret: handoff.secret,
 *       correct: clientResult.guess === handoff.secret,
 *     }
 *   })
 *
 *   return result
 * }
 * ```
 *
 * Naming options explored:
 * - phase1/phase2 - too generic
 * - beforeClient / afterClient - clear relationship to client
 * - setup / resume - implies suspension
 * - prepare / complete - implies preparation then completion
 * - handoff / resume - focuses on the handoff concept
 */
import { describe, it, expect, vi } from 'vitest'
import { run, type Operation } from 'effection'

// ============================================================================
// V5: Explicit Two-Phase API (beforeClient / afterClient)
// ============================================================================

/**
 * Special error to halt execution after beforeClient completes.
 */
class HandoffReadyError<T> extends Error {
  constructor(public readonly handoffData: T) {
    super('HandoffReady')
    this.name = 'HandoffReadyError'
  }
}

// --- V5 Types (simplified with any for exploratory code) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerOpV5 = (params: any, ctx: any) => Operation<any>

// --- V5 Phase 1 Executor ---

function* executePhase1V5<THandoff>(
  serverOp: ServerOpV5,
  params: unknown
): Operation<{ handoffData: THandoff }> {
  let handoffData: THandoff | undefined

  const ctx = {
    *beforeClient<T>(op: () => Operation<T>): Operation<T> {
      // Run the operation and capture the handoff
      handoffData = (yield* op()) as unknown as THandoff
      return handoffData as unknown as T
    },

    *afterClient<TResult>(_op: (clientResult: unknown) => Operation<TResult>): Operation<TResult> {
      // Halt here - phase 1 is complete
      throw new HandoffReadyError(handoffData)
    },
  }

  try {
    yield* serverOp(params, ctx)
    throw new Error('Server operation completed without calling afterClient()')
  } catch (e) {
    if (e instanceof HandoffReadyError) {
      return { handoffData: e.handoffData as THandoff }
    }
    throw e
  }
}

// --- V5 Phase 2 Executor ---

function* executePhase2V5<TResult>(
  serverOp: ServerOpV5,
  params: unknown,
  handoffData: unknown,
  clientOutput: unknown
): Operation<TResult> {
  const ctx = {
    *beforeClient<T>(_op: () => Operation<T>): Operation<T> {
      // Skip the operation, return cached handoff
      return handoffData as T
    },

    *afterClient<R>(op: (clientResult: unknown) => Operation<R>): Operation<R> {
      // Run the operation with client result
      return yield* op(clientOutput)
    },
  }

  return yield* serverOp(params, ctx)
}

// --- V5 Tests ---

describe('V5: beforeClient / afterClient API', () => {
  describe('basic functionality', () => {
    it('phase 1 runs beforeClient and captures handoff', async () => {
      const beforeFn = vi.fn()

      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: { ok: boolean }) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff = yield* ctx.beforeClient(function* () {
          beforeFn()
          return { data: 'handoff-data' }
        })

        const result = yield* ctx.afterClient(function* (clientResult) {
          return { handoff, clientResult }
        })

        return result
      }

      const phase1 = await run(function* () {
        return yield* executePhase1V5(serverOp, {})
      })

      expect(beforeFn).toHaveBeenCalledTimes(1)
      expect(phase1.handoffData).toEqual({ data: 'handoff-data' })
    })

    it('phase 2 skips beforeClient and runs afterClient', async () => {
      const beforeFn = vi.fn()
      const afterFn = vi.fn()

      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: { ok: boolean }) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff = yield* ctx.beforeClient(function* () {
          beforeFn()
          return { data: 'handoff-data' }
        })

        const result = yield* ctx.afterClient(function* (clientResult) {
          afterFn()
          return { handoff, clientResult }
        })

        return result
      }

      const result = await run(function* () {
        return yield* executePhase2V5(serverOp, {}, { data: 'cached-handoff' }, { ok: true })
      })

      expect(beforeFn).not.toHaveBeenCalled() // Skipped!
      expect(afterFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        handoff: { data: 'cached-handoff' },
        clientResult: { ok: true },
      })
    })

    it('full flow: phase 1 -> client -> phase 2', async () => {
      let computeCount = 0
      const expensiveCompute = () => {
        computeCount++
        return `Secret #${computeCount}`
      }

      function* serverOp(
        params: { playerName: string },
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: { guess: string }) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff = yield* ctx.beforeClient(function* () {
          const secret = expensiveCompute()
          return { secret, hint: 'Guess my card!' }
        })

        const result = yield* ctx.afterClient(function* (clientResult) {
          const correct = clientResult.guess === handoff.secret
          return {
            player: params.playerName,
            secret: handoff.secret,
            guess: clientResult.guess,
            correct,
          }
        })

        return result
      }

      // Phase 1
      const phase1 = await run(function* () {
        return yield* executePhase1V5(serverOp, { playerName: 'Alice' })
      })

      expect(computeCount).toBe(1)
      expect(phase1.handoffData).toEqual({ secret: 'Secret #1', hint: 'Guess my card!' })

      // Phase 2
      const result = await run(function* () {
        return yield* executePhase2V5(serverOp, { playerName: 'Alice' }, phase1.handoffData, {
          guess: 'Secret #1',
        })
      })

      expect(computeCount).toBe(1) // Still 1! expensiveCompute not called in phase 2
      expect(result).toEqual({
        player: 'Alice',
        secret: 'Secret #1',
        guess: 'Secret #1',
        correct: true,
      })
    })
  })

  describe('code between phases', () => {
    it('code between beforeClient and afterClient runs in BOTH phases (current impl)', async () => {
      const betweenFn = vi.fn()

      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: { y: number }) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff = yield* ctx.beforeClient(function* () {
          return { x: 1 }
        })

        // This runs in both phases with current implementation
        betweenFn(handoff.x)

        const result = yield* ctx.afterClient(function* (client) {
          return { x: handoff.x, y: client.y }
        })

        return result
      }

      // Phase 1 - betweenFn runs
      await run(function* () {
        return yield* executePhase1V5(serverOp, {})
      })
      expect(betweenFn).toHaveBeenCalledTimes(1)
      expect(betweenFn).toHaveBeenCalledWith(1)

      // Phase 2 - betweenFn runs again
      await run(function* () {
        return yield* executePhase2V5(serverOp, {}, { x: 1 }, { y: 2 })
      })
      expect(betweenFn).toHaveBeenCalledTimes(2)
    })
  })

  describe('error handling', () => {
    it('error in beforeClient propagates in phase 1', async () => {
      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: unknown) => Operation<T>) => Operation<T>
        }
      ) {
        yield* ctx.beforeClient(function* () {
          throw new Error('beforeClient error')
        })

        yield* ctx.afterClient(function* () {
          return {}
        })

        return {}
      }

      await expect(
        run(function* () {
          return yield* executePhase1V5(serverOp, {})
        })
      ).rejects.toThrow('beforeClient error')
    })

    it('error in afterClient propagates in phase 2', async () => {
      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: unknown) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff = yield* ctx.beforeClient(function* () {
          return { x: 1 }
        })

        yield* ctx.afterClient(function* () {
          throw new Error('afterClient error')
        })

        return handoff
      }

      await expect(
        run(function* () {
          return yield* executePhase2V5(serverOp, {}, { x: 1 }, {})
        })
      ).rejects.toThrow('afterClient error')
    })
  })

  describe('complex scenarios', () => {
    it('multiple yields inside beforeClient', async () => {
      const step1 = vi.fn()
      const step2 = vi.fn()

      function* asyncStep(val: string): Operation<string> {
        return `processed-${val}`
      }

      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: unknown) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff = yield* ctx.beforeClient(function* () {
          step1()
          const val1 = yield* asyncStep('a')
          step2()
          const val2 = yield* asyncStep('b')
          return { result: `${val1}-${val2}` }
        })

        const result = yield* ctx.afterClient(function* () {
          return handoff
        })

        return result
      }

      const phase1 = await run(function* () {
        return yield* executePhase1V5(serverOp, {})
      })

      expect(step1).toHaveBeenCalledTimes(1)
      expect(step2).toHaveBeenCalledTimes(1)
      expect(phase1.handoffData).toEqual({ result: 'processed-a-processed-b' })

      // Phase 2 should not re-run
      const result = await run(function* () {
        return yield* executePhase2V5(serverOp, {}, phase1.handoffData, {})
      })

      expect(step1).toHaveBeenCalledTimes(1) // Still 1
      expect(step2).toHaveBeenCalledTimes(1) // Still 1
      expect(result).toEqual({ result: 'processed-a-processed-b' })
    })

    it('afterClient can do complex processing of client result', async () => {
      interface Handoff {
        items: Array<{ id: string; price: number }>
      }
      interface ClientSelection {
        selectedIds: string[]
      }

      function* serverOp(
        _: unknown,
        ctx: {
          beforeClient: <T>(op: () => Operation<T>) => Operation<T>
          afterClient: <T>(op: (c: ClientSelection) => Operation<T>) => Operation<T>
        }
      ) {
        const handoff: Handoff = yield* ctx.beforeClient(function* () {
          return {
            items: [
              { id: 'a', price: 10 },
              { id: 'b', price: 20 },
              { id: 'c', price: 30 },
            ],
          }
        })

        const result = yield* ctx.afterClient(function* (client) {
          const selected = handoff.items.filter((item) => client.selectedIds.includes(item.id))
          const total = selected.reduce((sum, item) => sum + item.price, 0)
          return {
            selected,
            total,
            itemCount: selected.length,
          }
        })

        return result
      }

      // Phase 1
      const phase1 = await run(function* () {
        return yield* executePhase1V5(serverOp, {})
      })

      // Phase 2
      const result = await run(function* () {
        return yield* executePhase2V5(serverOp, {}, phase1.handoffData, {
          selectedIds: ['a', 'c'],
        })
      })

      expect(result).toEqual({
        selected: [
          { id: 'a', price: 10 },
          { id: 'c', price: 30 },
        ],
        total: 40,
        itemCount: 2,
      })
    })
  })
})

// ============================================================================
// V6: Can we avoid running "between" code twice?
// ============================================================================

describe('V6: Exploring ways to avoid running between-code twice', () => {
  /**
   * Approach 1: Add a `phase` property to context
   */
  it('approach 1: context exposes current phase', async () => {
    const betweenFn = vi.fn()

    function* serverOp(
      _: unknown,
      ctx: {
        phase: 1 | 2
        beforeClient: <T>(op: () => Operation<T>) => Operation<T>
        afterClient: <T>(op: (c: unknown) => Operation<T>) => Operation<T>
      }
    ) {
      const handoff = yield* ctx.beforeClient(function* () {
        return { x: 1 }
      })

      // Only run in phase 2
      if (ctx.phase === 2) {
        betweenFn(handoff.x)
      }

      const result = yield* ctx.afterClient(function* (client) {
        return { handoff, client }
      })

      return result
    }

    // Phase 1 executor with phase=1
    function* execPhase1(op: typeof serverOp, params: unknown) {
      let handoffData: unknown
      const ctx = {
        phase: 1 as const,
        *beforeClient<T>(innerOp: () => Operation<T>): Operation<T> {
          handoffData = yield* innerOp()
          return handoffData as T
        },
        *afterClient<T>(_innerOp: (c: unknown) => Operation<T>): Operation<T> {
          throw new HandoffReadyError(handoffData)
        },
      }
      try {
        yield* op(params, ctx)
      } catch (e) {
        if (e instanceof HandoffReadyError) return { handoffData: e.handoffData }
        throw e
      }
      throw new Error('unreachable')
    }

    // Phase 2 executor with phase=2
    function* execPhase2(op: typeof serverOp, params: unknown, handoff: unknown, client: unknown) {
      const ctx = {
        phase: 2 as const,
        *beforeClient<T>(_innerOp: () => Operation<T>): Operation<T> {
          return handoff as T
        },
        *afterClient<T>(innerOp: (c: unknown) => Operation<T>): Operation<T> {
          return yield* innerOp(client)
        },
      }
      return yield* op(params, ctx)
    }

    // Phase 1 - betweenFn should NOT run
    const phase1 = await run(function* () {
      return yield* execPhase1(serverOp, {})
    })
    expect(betweenFn).not.toHaveBeenCalled()

    // Phase 2 - betweenFn SHOULD run
    await run(function* () {
      return yield* execPhase2(serverOp, {}, phase1.handoffData, { y: 2 })
    })
    expect(betweenFn).toHaveBeenCalledTimes(1)
  })

  /**
   * Approach 2: Single handoff() operation with before/after callbacks
   *
   * This eliminates "between" code entirely - everything is in callbacks.
   */
  it('approach 2: single handoff() operation - no between code possible', async () => {
    const beforeFn = vi.fn()
    const afterFn = vi.fn()

    interface HandoffCtx {
      handoff: <THandoff, TClient, TResult>(config: {
        before: () => Operation<THandoff>
        after: (handoff: THandoff, client: TClient) => Operation<TResult>
      }) => Operation<TResult>
    }

    function* serverOp(params: { name: string }, ctx: HandoffCtx) {
      const result = yield* ctx.handoff({
        *before() {
          beforeFn()
          return { secret: 'abc', player: params.name }
        },
        *after(handoff, client: { guess: string }) {
          afterFn()
          return {
            player: handoff.player,
            correct: client.guess === handoff.secret,
          }
        },
      })

      // No code between phases - it's all in one operation!
      return result
    }

    // Phase 1 executor
    function* execPhase1(op: typeof serverOp, params: { name: string }) {
      let handoffData: unknown

      const ctx: HandoffCtx = {
        *handoff(config) {
          handoffData = yield* config.before()
          throw new HandoffReadyError(handoffData)
        },
      }

      try {
        yield* op(params, ctx)
      } catch (e) {
        if (e instanceof HandoffReadyError) {
          return { handoffData: e.handoffData }
        }
        throw e
      }
      throw new Error('unreachable')
    }

    // Phase 2 executor
    function* execPhase2(
      op: typeof serverOp,
      params: { name: string },
      handoff: unknown,
      client: unknown
    ) {
      const ctx: HandoffCtx = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        *handoff(config: any) {
          return yield* config.after(handoff, client)
        },
      }

      return yield* op(params, ctx)
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* execPhase1(serverOp, { name: 'Alice' })
    })

    expect(beforeFn).toHaveBeenCalledTimes(1)
    expect(afterFn).not.toHaveBeenCalled()
    expect(phase1.handoffData).toEqual({ secret: 'abc', player: 'Alice' })

    // Phase 2
    const result = await run(function* () {
      return yield* execPhase2(serverOp, { name: 'Alice' }, phase1.handoffData, { guess: 'abc' })
    })

    expect(beforeFn).toHaveBeenCalledTimes(1) // Still 1!
    expect(afterFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ player: 'Alice', correct: true })
  })

  /**
   * Approach 3: beforeClient returns a "continuation" that afterClient uses
   *
   * This is interesting - what if beforeClient returns something that
   * carries the handoff AND provides afterClient?
   */
  it('approach 3: chained API - beforeClient returns afterClient', async () => {
    const beforeFn = vi.fn()
    const afterFn = vi.fn()
    const betweenFn = vi.fn()

    interface Continuation<THandoff, TClient> {
      handoff: THandoff
      afterClient: <TResult>(
        op: (handoff: THandoff, client: TClient) => Operation<TResult>
      ) => Operation<TResult>
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type ChainedCtx = any // Simplified for exploratory code

    function* serverOp(params: { name: string }, ctx: ChainedCtx) {
      const cont: Continuation<{ secret: string }, { guess: string }> = yield* ctx.beforeClient(
        function* () {
          beforeFn()
          return { secret: 'xyz' }
        }
      )

      // Between code - can access handoff
      betweenFn(cont.handoff.secret)

      const result = yield* cont.afterClient(function* (handoff, client) {
        afterFn()
        return {
          player: params.name,
          secret: handoff.secret,
          correct: client.guess === handoff.secret,
        }
      })

      return result
    }

    // Phase 1 executor
    function* execPhase1(op: typeof serverOp, params: { name: string }) {
      let handoffData: unknown

      const ctx = {
        *beforeClient(innerOp: () => Operation<unknown>) {
          handoffData = yield* innerOp()
          return {
            handoff: handoffData,
            *afterClient() {
              throw new HandoffReadyError(handoffData)
            },
          }
        },
      }

      try {
        yield* op(params, ctx)
      } catch (e) {
        if (e instanceof HandoffReadyError) {
          return { handoffData: e.handoffData }
        }
        throw e
      }
      throw new Error('unreachable')
    }

    // Phase 2 executor
    function* execPhase2(
      op: typeof serverOp,
      params: { name: string },
      handoff: { secret: string },
      client: { guess: string }
    ) {
      const ctx = {
        *beforeClient(_innerOp: () => Operation<unknown>) {
          return {
            handoff,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            *afterClient(afterOp: any) {
              return yield* afterOp(handoff, client)
            },
          }
        },
      }

      return yield* op(params, ctx)
    }

    // Phase 1 - beforeFn and betweenFn run
    const phase1 = await run(function* () {
      return yield* execPhase1(serverOp, { name: 'Bob' })
    })

    expect(beforeFn).toHaveBeenCalledTimes(1)
    expect(betweenFn).toHaveBeenCalledTimes(1)
    expect(betweenFn).toHaveBeenCalledWith('xyz')
    expect(afterFn).not.toHaveBeenCalled()
    expect(phase1.handoffData).toEqual({ secret: 'xyz' })

    // Phase 2 - betweenFn runs again (with cached handoff), afterFn runs
    const result = await run(function* () {
      return yield* execPhase2(
        serverOp,
        { name: 'Bob' },
        phase1.handoffData as { secret: string },
        { guess: 'xyz' }
      )
    })

    expect(beforeFn).toHaveBeenCalledTimes(1) // Still 1 - skipped in phase 2
    expect(betweenFn).toHaveBeenCalledTimes(2) // Runs in both phases
    expect(afterFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ player: 'Bob', secret: 'xyz', correct: true })
  })
})

// ============================================================================
// V7: Best API - single handoff() with before/after
// ============================================================================

describe('V7: handoff() with before/after (recommended)', () => {
  /**
   * This is the cleanest API:
   * - Single operation: handoff({ before, after })
   * - No "between" code possible
   * - Clear separation of concerns
   * - Both callbacks have access to params via closure
   */

  interface HandoffConfig<THandoff, TClient, TResult> {
    before: () => Operation<THandoff>
    after: (handoff: THandoff, client: TClient) => Operation<TResult>
  }

  interface ServerCtx {
    handoff: <THandoff, TClient, TResult>(
      config: HandoffConfig<THandoff, TClient, TResult>
    ) => Operation<TResult>
  }

  // Phase 1 executor
  function* runPhase1(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serverOp: (params: any, ctx: ServerCtx) => Operation<any>,
    params: unknown
  ): Operation<{ handoffData: unknown }> {
    let handoffData: unknown

    const ctx: ServerCtx = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      *handoff(config: any) {
        handoffData = yield* config.before()
        throw new HandoffReadyError(handoffData)
      },
    }

    try {
      yield* serverOp(params, ctx)
    } catch (e) {
      if (e instanceof HandoffReadyError) {
        return { handoffData: e.handoffData }
      }
      throw e
    }
    throw new Error('unreachable')
  }

  // Phase 2 executor
  function* runPhase2<TResult>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serverOp: (params: any, ctx: ServerCtx) => Operation<any>,
    params: unknown,
    handoff: unknown,
    client: unknown
  ): Operation<TResult> {
    const ctx: ServerCtx = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      *handoff(config: any) {
        return yield* config.after(handoff, client)
      },
    }

    return yield* serverOp(params, ctx)
  }

  it('basic usage', async () => {
    function* serverOp(params: { name: string }, ctx: ServerCtx) {
      return yield* ctx.handoff({
        *before() {
          return { secret: 42, player: params.name }
        },
        *after(handoff, client: { guess: number }) {
          return {
            player: handoff.player,
            secret: handoff.secret,
            guess: client.guess,
            correct: client.guess === handoff.secret,
          }
        },
      })
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* runPhase1(serverOp, { name: 'Charlie' })
    })

    expect(phase1.handoffData).toEqual({ secret: 42, player: 'Charlie' })

    // Phase 2
    const result = await run(function* () {
      return yield* runPhase2(serverOp, { name: 'Charlie' }, phase1.handoffData, { guess: 42 })
    })

    expect(result).toEqual({
      player: 'Charlie',
      secret: 42,
      guess: 42,
      correct: true,
    })
  })

  it('expensive computation only runs once', async () => {
    let computeCount = 0

    function* serverOp(_: unknown, ctx: ServerCtx) {
      return yield* ctx.handoff({
        *before() {
          computeCount++
          return { computed: `value-${computeCount}` }
        },
        *after(handoff, client: { ack: boolean }) {
          return { value: handoff.computed, ack: client.ack }
        },
      })
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* runPhase1(serverOp, {})
    })
    expect(computeCount).toBe(1)

    // Phase 2
    const result = await run(function* () {
      return yield* runPhase2(serverOp, {}, phase1.handoffData, { ack: true })
    })
    expect(computeCount).toBe(1) // Still 1!
    expect(result).toEqual({ value: 'value-1', ack: true })
  })

  it('async operations in before()', async () => {
    let fetchCount = 0

    function* fetchData(): Operation<{ data: string }> {
      fetchCount++
      return { data: 'fetched' }
    }

    function* serverOp(_: unknown, ctx: ServerCtx) {
      return yield* ctx.handoff({
        *before() {
          const result = yield* fetchData()
          return { fetched: result.data }
        },
        *after(handoff, client: { ok: boolean }) {
          return { data: handoff.fetched, clientOk: client.ok }
        },
      })
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* runPhase1(serverOp, {})
    })
    expect(fetchCount).toBe(1)
    expect(phase1.handoffData).toEqual({ fetched: 'fetched' })

    // Phase 2
    const result = await run(function* () {
      return yield* runPhase2(serverOp, {}, phase1.handoffData, { ok: true })
    })
    expect(fetchCount).toBe(1) // Still 1!
    expect(result).toEqual({ data: 'fetched', clientOk: true })
  })

  it('error in before() propagates', async () => {
    function* serverOp(_: unknown, ctx: ServerCtx) {
      return yield* ctx.handoff({
        *before() {
          throw new Error('before failed')
        },
        *after() {
          return {}
        },
      })
    }

    await expect(
      run(function* () {
        return yield* runPhase1(serverOp, {})
      })
    ).rejects.toThrow('before failed')
  })

  it('error in after() propagates', async () => {
    function* serverOp(_: unknown, ctx: ServerCtx) {
      return yield* ctx.handoff({
        *before() {
          return { x: 1 }
        },
        *after() {
          throw new Error('after failed')
        },
      })
    }

    await expect(
      run(function* () {
        return yield* runPhase2(serverOp, {}, { x: 1 }, {})
      })
    ).rejects.toThrow('after failed')
  })

  it('code after handoff() runs in phase 2 only', async () => {
    const afterHandoffFn = vi.fn()

    function* serverOp(_: unknown, ctx: ServerCtx) {
      const result = yield* ctx.handoff({
        *before() {
          return { x: 1 }
        },
        *after(handoff, client: { y: number }) {
          return { x: handoff.x, y: client.y }
        },
      })

      // This only runs in phase 2
      afterHandoffFn(result)

      return { ...result, final: true }
    }

    // Phase 1 - afterHandoffFn should NOT run
    await run(function* () {
      return yield* runPhase1(serverOp, {})
    })
    expect(afterHandoffFn).not.toHaveBeenCalled()

    // Phase 2 - afterHandoffFn SHOULD run
    const result = await run(function* () {
      return yield* runPhase2(serverOp, {}, { x: 1 }, { y: 2 })
    })
    expect(afterHandoffFn).toHaveBeenCalledTimes(1)
    expect(afterHandoffFn).toHaveBeenCalledWith({ x: 1, y: 2 })
    expect(result).toEqual({ x: 1, y: 2, final: true })
  })

  it('multiple handoff() calls - current impl limitation', async () => {
    /**
     * LIMITATION: Current implementation doesn't properly support multiple handoff() calls.
     *
     * In phase 2, the ctx.handoff() implementation just calls config.after(handoff, client)
     * for EVERY handoff call, using the same cached handoff and client data.
     *
     * This means:
     * - First handoff.after() gets the correct data
     * - Second handoff.after() gets the SAME data (wrong!)
     * - before() is never called for either in phase 2 (correct for first, wrong for second)
     *
     * To properly support multiple handoffs, we'd need to:
     * 1. Track which handoff index we're at
     * 2. Store handoff data per-index
     * 3. Have separate client interactions per handoff
     *
     * For now, we document this limitation - tools should only have ONE handoff() call.
     */
    const handoff1Before = vi.fn()
    const handoff1After = vi.fn()
    const handoff2Before = vi.fn()
    const handoff2After = vi.fn()

    function* serverOp(_: unknown, ctx: ServerCtx) {
      const result1 = yield* ctx.handoff({
        *before() {
          handoff1Before()
          return { step: 1 }
        },
        *after(handoff, client: { ack1: boolean }) {
          handoff1After()
          return { step: handoff.step, ack1: client.ack1 }
        },
      })

      const result2 = yield* ctx.handoff({
        *before() {
          handoff2Before()
          return { step: 2, prev: result1 }
        },
        *after(handoff, client: { ack2: boolean }) {
          handoff2After()
          // Note: handoff here will be { step: 1 } - same as first handoff!
          return { step: handoff.step, ack2: client.ack2 }
        },
      })

      return { result1, result2 }
    }

    // Phase 1 - halts at first handoff
    const phase1 = await run(function* () {
      return yield* runPhase1(serverOp, {})
    })
    expect(handoff1Before).toHaveBeenCalledTimes(1)
    expect(handoff1After).not.toHaveBeenCalled()
    expect(handoff2Before).not.toHaveBeenCalled()
    expect(handoff2After).not.toHaveBeenCalled()
    expect(phase1.handoffData).toEqual({ step: 1 })

    // Phase 2 - both after() callbacks run with the SAME handoff data
    // This demonstrates the limitation
    const result = await run(function* () {
      return yield* runPhase2(serverOp, {}, phase1.handoffData, { ack1: true })
    })

    expect(handoff1Before).toHaveBeenCalledTimes(1) // Still 1 - skipped in phase 2
    expect(handoff2Before).not.toHaveBeenCalled() // Never called! Should have been.
    expect(handoff1After).toHaveBeenCalledTimes(1)
    expect(handoff2After).toHaveBeenCalledTimes(1)

    // Both results use step: 1 because both got the same handoff data
    expect(result).toEqual({
      result1: { step: 1, ack1: true },
      result2: { step: 1, ack2: undefined }, // ack2 undefined because client was { ack1: true }
    })
  })
})
