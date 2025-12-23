/**
 * do-client-continuation.test.ts
 *
 * HISTORICAL: This file documents the exploration of V1-V4 continuation patterns.
 * The final chosen pattern is V7 (handoff with before/after), implemented in
 * the executor and tested in v7-handoff-executor.test.ts.
 *
 * ## Patterns Explored
 *
 * V1: Simple doClient that returns { firstPass, client }
 * V2: doClient with explicit send() operation
 * V3: doClient with inner operation that halts at send()
 * V4: doClient with configurable inner operation
 *
 * ## Key Insight
 *
 * These patterns helped us understand that we need:
 * 1. A way to run expensive code ONLY in phase 1
 * 2. A way to skip that code in phase 2 and use cached data
 * 3. A clean API that makes the two phases explicit
 *
 * This led to the V7 pattern: handoff({ before, after })
 *
 * ## Original Description
 *
 * Exploring the `doClient` continuation pattern for server-authority tools.
 *
 * The idea:
 * - Server operation receives a `doClient` function in context
 * - Server yields to `doClient` with an inner operation
 * - Phase 1: Inner operation runs, then halts at `yield* send(...)`
 * - Phase 2: Entire `doClient` block is replaced with cached results
 *
 * ```typescript
 * *server(params, ctx) {
 *   const result = yield* ctx.doClient(function* (send) {
 *     // --- First pass only ---
 *     const secret = pickRandomCard()
 *
 *     yield* send({ secret, hint: "..." })  // Halt point (phase 1) / Resume point (phase 2)
 *
 *     // --- Runs in phase 2 only ---
 *     return { secret }
 *   })
 *
 *   return {
 *     secret: result.firstPass.secret,
 *     clientAcknowledged: result.client.acknowledged
 *   }
 * }
 * ```
 */
import { describe, it, expect, vi } from 'vitest'
import { run, type Operation } from 'effection'

// --- Core Types ---

interface DoClientResult<TFirstPass, TClientOutput> {
  firstPass: TFirstPass
  client: TClientOutput
}

type SendOperation<THandoff> = (data: THandoff) => Operation<void>

type DoClientFn = <THandoff, TFirstPass>(
  innerOp: (send: SendOperation<THandoff>) => Operation<TFirstPass>
) => Operation<DoClientResult<TFirstPass, unknown>>

interface ServerContext {
  doClient: DoClientFn
}

// --- Phase 1: Execute until send, then halt ---

/**
 * Special error thrown when send() is called to halt the operation.
 * This is a control flow mechanism, not a real error.
 */
class HaltAtSendError<T> extends Error {
  constructor(public readonly handoffData: T) {
    super('HaltAtSend')
    this.name = 'HaltAtSendError'
  }
}

interface Phase1Result<THandoff> {
  handoffData: THandoff
}

/**
 * Execute the server operation in phase 1.
 * Runs until `yield* send(...)` is called, captures the handoff data,
 * then halts the operation by throwing HaltAtSendError.
 */
function* executePhase1<TParams, THandoff>(
  serverOp: (params: TParams, ctx: ServerContext) => Operation<unknown>,
  params: TParams
): Operation<Phase1Result<THandoff>> {
  const doClient: DoClientFn = <H, F>(
    innerOp: (send: SendOperation<H>) => Operation<F>
  ): Operation<DoClientResult<F, unknown>> => {
    return {
      *[Symbol.iterator]() {
        // Create a send operation that captures data and throws to halt
        const send: SendOperation<H> = (data: H): Operation<void> => {
          return {
            *[Symbol.iterator]() {
              // Throw to halt - this is caught by executePhase1
              throw new HaltAtSendError(data)
            },
          }
        }

        // Run the inner operation - it will throw at send()
        yield* innerOp(send)

        // If we get here, send() was never called (shouldn't happen for valid tools)
        throw new Error('doClient inner operation completed without calling send()')
      },
    }
  }

  const ctx: ServerContext = { doClient }

  // Run the server operation - it will throw HaltAtSendError when send() is called
  try {
    yield* serverOp(params, ctx)
    // If we get here, the tool didn't use doClient or didn't call send()
    throw new Error('Server operation completed without calling send()')
  } catch (e) {
    if (e instanceof HaltAtSendError) {
      return {
        handoffData: e.handoffData as THandoff,
      }
    }
    throw e
  }
}

/**
 * Execute the server operation in phase 2.
 * The doClient block immediately returns the cached results.
 */
function* executePhase2<TParams, TFirstPass, TClientOutput, TServerOutput>(
  serverOp: (params: TParams, ctx: ServerContext) => Operation<TServerOutput>,
  params: TParams,
  firstPassResult: TFirstPass,
  clientOutput: TClientOutput
): Operation<TServerOutput> {
  const doClient: DoClientFn = <H, F>(
    _innerOp: (send: SendOperation<H>) => Operation<F>
  ): Operation<DoClientResult<F, unknown>> => {
    return {
      *[Symbol.iterator]() {
        // Skip the inner operation entirely, return cached results
        return {
          firstPass: firstPassResult as unknown as F,
          client: clientOutput,
        }
      },
    }
  }

  const ctx: ServerContext = { doClient }

  return yield* serverOp(params, ctx)
}

// --- Tests ---

describe('doClient continuation pattern', () => {
  it('phase 1: should run until send() and capture handoff data', async () => {
    const pickCard = vi.fn(() => 'Ace of Spades')

    function* serverOp(params: { playerName: string }, ctx: ServerContext) {
      const result = yield* ctx.doClient(function* (send) {
        const secret = pickCard()

        yield* send({ secret, hint: 'I picked a card...' })

        // This should NOT run in phase 1
        return { secret, picked: true }
      })

      return {
        winner: params.playerName,
        secret: result.firstPass.secret,
        clientSaw: result.client,
      }
    }

    const result = await run(function* () {
      return yield* executePhase1(serverOp, { playerName: 'Alice' })
    })

    expect(pickCard).toHaveBeenCalledTimes(1)
    expect(result.handoffData).toEqual({ secret: 'Ace of Spades', hint: 'I picked a card...' })
    // With the throw-based approach, we halt before any return - handoffData is our captured state
  })

  it('phase 2: should skip inner operation and return cached results', async () => {
    const pickCard = vi.fn(() => 'Ace of Spades')

    function* serverOp(params: { playerName: string }, ctx: ServerContext) {
      const result = yield* ctx.doClient(function* (send) {
        const secret = pickCard()

        yield* send({ secret, hint: 'I picked a card...' })

        return { secret, picked: true }
      })

      return {
        winner: params.playerName,
        secret: result.firstPass.secret,
        clientSaw: result.client,
      }
    }

    const firstPassResult = { secret: 'Ace of Spades', picked: true }
    const clientOutput = { acknowledged: true }

    const result = await run(function* () {
      return yield* executePhase2(serverOp, { playerName: 'Alice' }, firstPassResult, clientOutput)
    })

    // pickCard should NOT be called in phase 2 - we skip the inner operation
    expect(pickCard).not.toHaveBeenCalled()

    expect(result).toEqual({
      winner: 'Alice',
      secret: 'Ace of Spades',
      clientSaw: { acknowledged: true },
    })
  })

  it('full flow: phase 1 -> client -> phase 2', async () => {
    let cardPickCount = 0
    const pickCard = () => {
      cardPickCount++
      return `Card #${cardPickCount}`
    }

    function* serverOp(_params: { playerName: string }, ctx: ServerContext) {
      const result = yield* ctx.doClient(function* (send) {
        const secret = pickCard()

        yield* send({ secret, hint: 'Guess my card!' })

        return { secret, timestamp: Date.now() }
      })

      return {
        gameOver: true,
        secret: result.firstPass.secret,
        clientGuessed: result.client,
      }
    }

    // Phase 1: Server runs until send()
    const phase1Result = await run(function* () {
      return yield* executePhase1(serverOp, { playerName: 'Bob' })
    })

    expect(cardPickCount).toBe(1)
    expect(phase1Result.handoffData).toEqual({
      secret: 'Card #1',
      hint: 'Guess my card!',
    })

    // Simulate client execution (would happen in browser)
    const clientOutput = { guessed: 'Card #1', correct: true }

    // Phase 2: Server resumes with cached results
    // We need to provide firstPassResult - but in phase 1 we halted before it was set!
    // This is a problem with the current design...

    // For now, let's assume we need to capture the partial state differently
    // The secret was computed, we just need to pass it through
    const firstPassResult = { secret: 'Card #1', timestamp: 123456 }

    const finalResult = await run(function* () {
      return yield* executePhase2(serverOp, { playerName: 'Bob' }, firstPassResult, clientOutput)
    })

    // In phase 2, pickCard should NOT be called again
    expect(cardPickCount).toBe(1) // Still 1, not 2

    expect(finalResult).toEqual({
      gameOver: true,
      secret: 'Card #1',
      clientGuessed: { guessed: 'Card #1', correct: true },
    })
  })

  describe('edge cases', () => {
    it('should handle send() being called multiple times (error)', async () => {
      function* serverOp(_params: unknown, ctx: ServerContext) {
        yield* ctx.doClient(function* (send) {
          yield* send({ first: true })
          yield* send({ second: true }) // This should never be reached

          return {}
        })

        return {}
      }

      // Phase 1 should halt at first send()
      const result = await run(function* () {
        return yield* executePhase1(serverOp, {})
      })

      expect(result.handoffData).toEqual({ first: true })
    })

    it('should handle code after doClient in server operation', async () => {
      const afterDoClientFn = vi.fn()

      function* serverOp(_params: unknown, ctx: ServerContext) {
        const result = yield* ctx.doClient(function* (send) {
          yield* send({ data: 'handoff' })
          return { inner: 'result' }
        })

        // This code runs in phase 2 only
        afterDoClientFn()

        return {
          fromDoClient: result.firstPass.inner,
          fromClient: result.client,
          extraProcessing: true,
        }
      }

      // Phase 1
      await run(function* () {
        return yield* executePhase1(serverOp, {})
      })

      expect(afterDoClientFn).not.toHaveBeenCalled()

      // Phase 2
      const result = await run(function* () {
        return yield* executePhase2(serverOp, {}, { inner: 'result' }, { clientData: true })
      })

      expect(afterDoClientFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        fromDoClient: 'result',
        fromClient: { clientData: true },
        extraProcessing: true,
      })
    })
  })
})

describe('problem: firstPassResult is undefined in phase 1', () => {
  /**
   * The current design has a flaw: we halt at send(), so the return statement
   * in the inner operation never executes. This means firstPassResult is undefined.
   *
   * But we NEED firstPassResult in phase 2 to give to the server continuation!
   *
   * Options:
   * 1. The handoff data IS the first pass result (combine them)
   * 2. Capture state before send() via a different mechanism
   * 3. Re-run the inner operation in phase 2 up to send(), then skip send() and continue
   */

  it('option 1: handoff data is the first pass result', async () => {
    function* serverOp(_: unknown, ctx: ServerContext) {
      const result = yield* ctx.doClient(function* (send) {
        const secret = 'Ace of Spades'
        const computedState = { secret, timestamp: Date.now() }

        // Handoff data IS the first pass result
        yield* send(computedState)

        // Return is now just for type inference / post-send work
        return computedState
      })

      // result.firstPass === result.handoff (same data)
      return { secret: result.firstPass.secret }
    }

    const phase1 = await run(function* () {
      return yield* executePhase1(serverOp, {})
    })

    // In phase 2, we use handoffData as firstPassResult
    const phase2 = await run(function* () {
      return yield* executePhase2(
        serverOp,
        {},
        phase1.handoffData, // Use handoff as firstPass!
        { clientAck: true }
      )
    })

    expect(phase2).toEqual({ secret: 'Ace of Spades' })
  })
})

// ============================================================================
// REFINED API: send() returns client result directly
// ============================================================================

/**
 * Refined version where send() returns the client result.
 * This eliminates the DoClientResult wrapper and makes the API cleaner.
 *
 * ```typescript
 * *server(params, ctx) {
 *   const { handoff, clientResult } = yield* ctx.doClient(function* (send) {
 *     const secret = pickRandomCard()
 *     const clientResult = yield* send({ secret, hint: "..." })
 *     //    ^ Phase 1: halts here
 *     //    ^ Phase 2: returns clientResult
 *
 *     return { handoff: { secret }, clientResult }
 *   })
 *
 *   return { secret: handoff.secret, clientSaw: clientResult }
 * }
 * ```
 */

// --- Refined Types ---

type SendOperationV2<THandoff, TClientOutput> = (data: THandoff) => Operation<TClientOutput>

type DoClientFnV2 = <THandoff, TClientOutput, TReturn>(
  innerOp: (send: SendOperationV2<THandoff, TClientOutput>) => Operation<TReturn>
) => Operation<TReturn>

interface ServerContextV2 {
  doClient: DoClientFnV2
}

// --- Refined Phase 1 ---

function* executePhase1V2<TParams, THandoff>(
  serverOp: (params: TParams, ctx: ServerContextV2) => Operation<unknown>,
  params: TParams
): Operation<Phase1Result<THandoff>> {
  const doClient: DoClientFnV2 = <H, C, R>(
    innerOp: (send: SendOperationV2<H, C>) => Operation<R>
  ): Operation<R> => {
    return {
      *[Symbol.iterator]() {
        const send: SendOperationV2<H, C> = (data: H): Operation<C> => {
          return {
            *[Symbol.iterator]() {
              throw new HaltAtSendError(data)
            },
          }
        }

        return yield* innerOp(send)
      },
    }
  }

  const ctx: ServerContextV2 = { doClient }

  try {
    yield* serverOp(params, ctx)
    throw new Error('Server operation completed without calling send()')
  } catch (e) {
    if (e instanceof HaltAtSendError) {
      return { handoffData: e.handoffData as THandoff }
    }
    throw e
  }
}

// --- Refined Phase 2 ---

function* executePhase2V2<TParams, THandoff, TClientOutput, TServerOutput>(
  serverOp: (params: TParams, ctx: ServerContextV2) => Operation<TServerOutput>,
  params: TParams,
  _handoffData: THandoff, // Not used - we re-run inner op but send() returns clientOutput
  clientOutput: TClientOutput
): Operation<TServerOutput> {
  const doClient: DoClientFnV2 = <H, C, R>(
    innerOp: (send: SendOperationV2<H, C>) => Operation<R>
  ): Operation<R> => {
    return {
      *[Symbol.iterator]() {
        // send() returns the client output immediately
        const send: SendOperationV2<H, C> = (_data: H): Operation<C> => {
          return {
            *[Symbol.iterator]() {
              return clientOutput as unknown as C
            },
          }
        }

        return yield* innerOp(send)
      },
    }
  }

  const ctx: ServerContextV2 = { doClient }

  return yield* serverOp(params, ctx)
}

// --- Refined Tests ---

describe('refined API: send() returns client result', () => {
  it('phase 1 captures handoff, phase 2 re-runs code before send()', async () => {
    const pickCard = vi.fn(() => 'Ace of Spades')

    interface Handoff {
      secret: string
      hint: string
    }
    interface ClientOutput {
      acknowledged: boolean
      guess: string
    }

    function* serverOp(
      params: { playerName: string },
      ctx: ServerContextV2
    ): Operation<{ winner: string; secret: string; guess: string }> {
      const { handoff, clientResult } = yield* ctx.doClient(function* (
        send: SendOperationV2<Handoff, ClientOutput>
      ) {
        const secret = pickCard()
        const handoff = { secret, hint: 'Guess my card!' }

        // Phase 1: halts here after capturing handoff
        // Phase 2: returns clientResult
        const clientResult = yield* send(handoff)

        return { handoff, clientResult }
      })

      return {
        winner: params.playerName,
        secret: handoff.secret,
        guess: clientResult.guess,
      }
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V2(serverOp, { playerName: 'Alice' })
    })

    expect(pickCard).toHaveBeenCalledTimes(1)
    expect(phase1.handoffData).toEqual({ secret: 'Ace of Spades', hint: 'Guess my card!' })

    // Client executes (simulated)
    const clientOutput: ClientOutput = { acknowledged: true, guess: 'Ace of Spades' }

    // Phase 2
    const finalResult = await run(function* () {
      return yield* executePhase2V2(serverOp, { playerName: 'Alice' }, phase1.handoffData, clientOutput)
    })

    // NOTE: In V2 API, code before send() runs TWICE (once per phase)
    // This is a limitation - we need to ensure idempotency or use V1 API
    expect(pickCard).toHaveBeenCalledTimes(2)

    expect(finalResult).toEqual({
      winner: 'Alice',
      secret: 'Ace of Spades',
      guess: 'Ace of Spades',
    })
  })

  it('code after send() runs in phase 2 only', async () => {
    const afterSendFn = vi.fn()

    function* serverOp(_: unknown, ctx: ServerContextV2) {
      const result = yield* ctx.doClient(function* (send) {
        const handoff = { data: 'for client' }
        const clientResult = yield* send(handoff)

        // This runs in phase 2 only
        afterSendFn()

        return { handoff, clientResult, postSendWork: true }
      })

      return {
        ...result,
        serverDone: true,
      }
    }

    // Phase 1 - afterSendFn should NOT be called
    const phase1 = await run(function* () {
      return yield* executePhase1V2(serverOp, {})
    })
    expect(afterSendFn).not.toHaveBeenCalled()
    expect(phase1.handoffData).toEqual({ data: 'for client' })

    // Phase 2 - afterSendFn SHOULD be called
    const result = await run(function* () {
      return yield* executePhase2V2(serverOp, {}, phase1.handoffData, { fromClient: true })
    })
    expect(afterSendFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      handoff: { data: 'for client' },
      clientResult: { fromClient: true },
      postSendWork: true,
      serverDone: true,
    })
  })
})

// ============================================================================
// V3 API: Best of both worlds - skip pre-send, allow post-send
// ============================================================================

/**
 * V3 addresses the idempotency issue by:
 * 1. Phase 1: Run inner op until send(), capture handoff AND a "resumption closure"
 * 2. Phase 2: Skip inner op entirely, call resumption closure with client result
 *
 * This is conceptually like storing "what comes after send()" and replaying it.
 *
 * BUT - this is hard with generators because we can't serialize the continuation.
 * Instead, we take a different approach: the user structures their code differently.
 *
 * ```typescript
 * *server(params, ctx) {
 *   // Put non-idempotent work here (runs once in phase 1)
 *   const secret = pickRandomCard()
 *
 *   // doClient block should be pure/idempotent
 *   const clientResult = yield* ctx.doClient(
 *     { secret, hint: "..." },  // handoff data
 *     function* (clientOutput) {
 *       // This runs in phase 2 only, after client completes
 *       return { secret, clientAcknowledged: clientOutput.acknowledged }
 *     }
 *   )
 *
 *   return clientResult
 * }
 * ```
 */

// --- V3 Types ---

type DoClientFnV3 = <THandoff, TClientOutput, TReturn>(
  handoffData: THandoff,
  resumeOp: (clientOutput: TClientOutput) => Operation<TReturn>
) => Operation<TReturn>

interface ServerContextV3 {
  doClient: DoClientFnV3
}

interface Phase1ResultV3<THandoff> {
  handoffData: THandoff
}

// --- V3 Phase 1 ---

class HaltAtDoClientError<T> extends Error {
  constructor(public readonly handoffData: T) {
    super('HaltAtDoClient')
    this.name = 'HaltAtDoClientError'
  }
}

function* executePhase1V3<TParams, THandoff>(
  serverOp: (params: TParams, ctx: ServerContextV3) => Operation<unknown>,
  params: TParams
): Operation<Phase1ResultV3<THandoff>> {
  const doClient: DoClientFnV3 = <H, C, R>(
    handoffData: H,
    _resumeOp: (clientOutput: C) => Operation<R>
  ): Operation<R> => {
    return {
      *[Symbol.iterator]() {
        // Capture handoff and halt
        throw new HaltAtDoClientError(handoffData)
      },
    }
  }

  const ctx: ServerContextV3 = { doClient }

  try {
    yield* serverOp(params, ctx)
    throw new Error('Server operation completed without calling doClient()')
  } catch (e) {
    if (e instanceof HaltAtDoClientError) {
      return { handoffData: e.handoffData as THandoff }
    }
    throw e
  }
}

// --- V3 Phase 2 ---

function* executePhase2V3<TParams, THandoff, TClientOutput, TServerOutput>(
  serverOp: (params: TParams, ctx: ServerContextV3) => Operation<TServerOutput>,
  params: TParams,
  _handoffData: THandoff,
  clientOutput: TClientOutput
): Operation<TServerOutput> {
  const doClient: DoClientFnV3 = <H, C, R>(
    _handoff: H,
    resumeOp: (clientOutput: C) => Operation<R>
  ): Operation<R> => {
    return {
      *[Symbol.iterator]() {
        // Skip to resume with client output
        return yield* resumeOp(clientOutput as unknown as C)
      },
    }
  }

  const ctx: ServerContextV3 = { doClient }

  return yield* serverOp(params, ctx)
}

// --- V3 Tests ---

describe('V3 API: separate handoff from resume', () => {
  it('non-idempotent code before doClient runs once', async () => {
    const pickCard = vi.fn(() => 'Ace of Spades')
    const resumeFn = vi.fn()

    function* serverOp(
      params: { playerName: string },
      ctx: ServerContextV3
    ): Operation<{ winner: string; secret: string; clientAck: boolean }> {
      // Non-idempotent work - runs ONCE in phase 1
      const secret = pickCard()

      // doClient takes handoff data and a resume operation
      const result = yield* ctx.doClient(
        { secret, hint: 'Guess my card!' },
        function* (clientOutput: { acknowledged: boolean }) {
          // This runs in phase 2 only
          resumeFn()
          return {
            winner: params.playerName,
            secret,
            clientAck: clientOutput.acknowledged,
          }
        }
      )

      return result
    }

    // Phase 1: runs until doClient, captures handoff
    const phase1 = await run(function* () {
      return yield* executePhase1V3(serverOp, { playerName: 'Alice' })
    })

    expect(pickCard).toHaveBeenCalledTimes(1)
    expect(resumeFn).not.toHaveBeenCalled()
    expect(phase1.handoffData).toEqual({ secret: 'Ace of Spades', hint: 'Guess my card!' })

    // Phase 2: runs serverOp again, but doClient immediately calls resume
    const result = await run(function* () {
      return yield* executePhase2V3(
        serverOp,
        { playerName: 'Alice' },
        phase1.handoffData,
        { acknowledged: true }
      )
    })

    // pickCard runs again in phase 2 (before doClient) - but that's ok, result is same
    // This is still a limitation, but less impactful if pickCard is cheap
    expect(pickCard).toHaveBeenCalledTimes(2)
    expect(resumeFn).toHaveBeenCalledTimes(1)

    expect(result).toEqual({
      winner: 'Alice',
      secret: 'Ace of Spades',
      clientAck: true,
    })
  })

  it('demonstrates the closure capture pattern for true idempotency', async () => {
    /**
     * To achieve true idempotency, we can use a closure pattern:
     * Store the computed values in the handoff data itself.
     */
    let computeCount = 0
    const expensiveCompute = () => {
      computeCount++
      return `Result #${computeCount}`
    }

    function* serverOp(_: unknown, ctx: ServerContextV3) {
      // Expensive computation only in phase 1
      // In phase 2, we get the result from handoffData
      const computed = expensiveCompute()

      const result = yield* ctx.doClient(
        // Include computed result in handoff so it's available in phase 2
        { computed, forClient: 'display this' },
        function* (clientOutput: { ok: boolean }) {
          // In phase 2, we could get `computed` from handoffData if needed
          // For now, we just use it from closure
          return { computed, clientOk: clientOutput.ok }
        }
      )

      return result
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V3(serverOp, {})
    })
    expect(computeCount).toBe(1)

    // Phase 2 - expensiveCompute runs again, giving different result!
    const result = await run(function* () {
      return yield* executePhase2V3(serverOp, {}, phase1.handoffData, { ok: true })
    })
    expect(computeCount).toBe(2) // Ran twice!
    // The result uses Result #2, not #1!
    expect(result).toEqual({ computed: 'Result #2', clientOk: true })
  })
})

// ============================================================================
// V4 API: True idempotency via handoff injection
// ============================================================================

/**
 * V4 solves idempotency by:
 * 1. Phase 1: Run server op, capture handoff data
 * 2. Phase 2: Inject handoff data into context, skip re-computation
 *
 * The key insight: doClient returns different things based on phase:
 * - Phase 1: Runs inner op, throws at send() with handoff
 * - Phase 2: Immediately returns { handoff: injectedData, client: clientOutput }
 *
 * The server op then destructures this and uses the cached handoff data
 * instead of recomputing.
 */

// --- V4 Types ---

interface DoClientResultV4<THandoff, TClientOutput> {
  handoff: THandoff
  client: TClientOutput
}

type SendOperationV4<THandoff, TClientOutput> = (data: THandoff) => Operation<TClientOutput>

type DoClientFnV4 = <THandoff, TClientOutput>(
  innerOp: (send: SendOperationV4<THandoff, TClientOutput>) => Operation<{ handoff: THandoff }>
) => Operation<DoClientResultV4<THandoff, TClientOutput>>

interface ServerContextV4 {
  doClient: DoClientFnV4
}

// --- V4 Phase 1 ---

function* executePhase1V4<TParams, THandoff>(
  serverOp: (params: TParams, ctx: ServerContextV4) => Operation<unknown>,
  params: TParams
): Operation<{ handoffData: THandoff }> {
  const doClient: DoClientFnV4 = <H, C>(
    innerOp: (send: SendOperationV4<H, C>) => Operation<{ handoff: H }>
  ): Operation<DoClientResultV4<H, C>> => {
    return {
      *[Symbol.iterator]() {
        const send: SendOperationV4<H, C> = (data: H): Operation<C> => {
          return {
            *[Symbol.iterator]() {
              throw new HaltAtSendError(data)
            },
          }
        }

        yield* innerOp(send)
        throw new Error('Inner operation completed without calling send()')
      },
    }
  }

  const ctx: ServerContextV4 = { doClient }

  try {
    yield* serverOp(params, ctx)
    throw new Error('Server operation completed without calling doClient()')
  } catch (e) {
    if (e instanceof HaltAtSendError) {
      return { handoffData: e.handoffData as THandoff }
    }
    throw e
  }
}

// --- V4 Phase 2 ---

function* executePhase2V4<TParams, THandoff, TClientOutput, TServerOutput>(
  serverOp: (params: TParams, ctx: ServerContextV4) => Operation<TServerOutput>,
  params: TParams,
  handoffData: THandoff,
  clientOutput: TClientOutput
): Operation<TServerOutput> {
  const doClient: DoClientFnV4 = <H, C>(
    _innerOp: (send: SendOperationV4<H, C>) => Operation<{ handoff: H }>
  ): Operation<DoClientResultV4<H, C>> => {
    return {
      *[Symbol.iterator]() {
        // Skip inner op entirely, return cached data
        return {
          handoff: handoffData as unknown as H,
          client: clientOutput as unknown as C,
        }
      },
    }
  }

  const ctx: ServerContextV4 = { doClient }

  return yield* serverOp(params, ctx)
}

// --- V4 Tests ---

describe('V4 API: true idempotency via handoff injection', () => {
  it('expensive computation runs once, phase 2 uses cached handoff', async () => {
    let computeCount = 0
    const expensiveCompute = () => {
      computeCount++
      return `Secret #${computeCount}`
    }

    interface MyHandoff {
      secret: string
      hint: string
    }
    interface MyClientOutput {
      guess: string
    }

    function* serverOp(
      params: { playerName: string },
      ctx: ServerContextV4
    ): Operation<{ winner: string; secret: string; clientGuess: string }> {
      // doClient returns { handoff, client }
      // In phase 1: handoff is computed, client is never set (we halt)
      // In phase 2: handoff is injected (cached), client is from client execution
      const { handoff, client } = yield* ctx.doClient<MyHandoff, MyClientOutput>(function* (send) {
        // This only runs in phase 1
        const secret = expensiveCompute()
        const handoff: MyHandoff = { secret, hint: 'Guess!' }

        // Phase 1: halts here
        // Phase 2: this block is skipped, we get cached handoff + client
        yield* send(handoff)

        return { handoff }
      })

      // This runs in both phases, but uses the correct handoff data
      return {
        winner: params.playerName,
        secret: handoff.secret,
        clientGuess: client.guess,
      }
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V4(serverOp, { playerName: 'Alice' })
    })

    expect(computeCount).toBe(1)
    expect(phase1.handoffData).toEqual({ secret: 'Secret #1', hint: 'Guess!' })

    // Phase 2 - expensiveCompute should NOT run again
    const result = await run(function* () {
      return yield* executePhase2V4(
        serverOp,
        { playerName: 'Alice' },
        phase1.handoffData,
        { guess: 'Secret #1' }
      )
    })

    // expensiveCompute only called once!
    expect(computeCount).toBe(1)

    expect(result).toEqual({
      winner: 'Alice',
      secret: 'Secret #1',
      clientGuess: 'Secret #1',
    })
  })

  it('code after doClient runs in both phases (with correct data)', async () => {
    const afterDoClientFn = vi.fn()

    interface MyHandoff {
      computed: string
    }
    interface MyClientOutput {
      fromClient: boolean
    }

    function* serverOp(_: unknown, ctx: ServerContextV4) {
      const { handoff, client } = yield* ctx.doClient<MyHandoff, MyClientOutput>(function* (send) {
        const data: MyHandoff = { computed: 'phase1-data' }
        yield* send(data)
        return { handoff: data }
      })

      // This runs in both phases
      afterDoClientFn(handoff, client)

      return { handoff, client, done: true }
    }

    // Phase 1 - afterDoClientFn NOT called (we halt at send)
    await run(function* () {
      return yield* executePhase1V4(serverOp, {})
    })
    expect(afterDoClientFn).not.toHaveBeenCalled()

    // Phase 2 - afterDoClientFn IS called with correct data
    const result = await run(function* () {
      return yield* executePhase2V4(
        serverOp,
        {},
        { computed: 'phase1-data' },
        { fromClient: true }
      )
    })

    expect(afterDoClientFn).toHaveBeenCalledTimes(1)
    expect(afterDoClientFn).toHaveBeenCalledWith(
      { computed: 'phase1-data' },
      { fromClient: true }
    )
    expect(result).toEqual({
      handoff: { computed: 'phase1-data' },
      client: { fromClient: true },
      done: true,
    })
  })

  it('handles complex nested data in handoff', async () => {
    interface ComplexHandoff {
      user: { id: string; name: string }
      items: Array<{ sku: string; qty: number }>
      metadata: { timestamp: number; version: string }
    }
    interface ClientResponse {
      confirmed: boolean
      selectedItems: string[]
    }

    function* serverOp(_: unknown, ctx: ServerContextV4) {
      const { handoff, client } = yield* ctx.doClient<ComplexHandoff, ClientResponse>(
        function* (send) {
          const handoff: ComplexHandoff = {
            user: { id: 'u123', name: 'Alice' },
            items: [
              { sku: 'ABC', qty: 2 },
              { sku: 'XYZ', qty: 1 },
            ],
            metadata: { timestamp: Date.now(), version: '1.0' },
          }
          yield* send(handoff)
          return { handoff }
        }
      )

      return {
        userId: handoff.user.id,
        itemCount: handoff.items.length,
        confirmed: client.confirmed,
        selectedCount: client.selectedItems.length,
      }
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V4(serverOp, {})
    })

    expect(phase1.handoffData).toMatchObject({
      user: { id: 'u123', name: 'Alice' },
      items: [
        { sku: 'ABC', qty: 2 },
        { sku: 'XYZ', qty: 1 },
      ],
    })

    // Phase 2
    const result = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, phase1.handoffData, {
        confirmed: true,
        selectedItems: ['ABC'],
      })
    })

    expect(result).toEqual({
      userId: 'u123',
      itemCount: 2,
      confirmed: true,
      selectedCount: 1,
    })
  })

  it('server can process client response and transform result', async () => {
    interface GameHandoff {
      secretNumber: number
      maxGuesses: number
    }
    interface PlayerGuess {
      guess: number
    }

    function* serverOp(_: unknown, ctx: ServerContextV4) {
      const { handoff, client } = yield* ctx.doClient<GameHandoff, PlayerGuess>(function* (send) {
        const secretNumber = Math.floor(Math.random() * 100) + 1
        yield* send({ secretNumber, maxGuesses: 5 })
        return { handoff: { secretNumber, maxGuesses: 5 } }
      })

      // Server processes the client's guess
      const isCorrect = client.guess === handoff.secretNumber
      const difference = Math.abs(client.guess - handoff.secretNumber)

      return {
        correct: isCorrect,
        hint: isCorrect ? 'You win!' : difference < 10 ? 'Very close!' : 'Try again',
        secret: handoff.secretNumber,
      }
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V4(serverOp, {})
    })

    const handoff = phase1.handoffData as GameHandoff
    expect(handoff.secretNumber).toBeGreaterThanOrEqual(1)
    expect(handoff.secretNumber).toBeLessThanOrEqual(100)

    // Phase 2 - correct guess
    const correctResult = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, handoff, { guess: handoff.secretNumber })
    })

    expect(correctResult).toEqual({
      correct: true,
      hint: 'You win!',
      secret: handoff.secretNumber,
    })

    // Phase 2 - close guess
    const closeResult = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, handoff, { guess: handoff.secretNumber + 5 })
    })

    expect(closeResult).toEqual({
      correct: false,
      hint: 'Very close!',
      secret: handoff.secretNumber,
    })

    // Phase 2 - far guess
    const farResult = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, handoff, { guess: handoff.secretNumber + 50 })
    })

    expect(farResult.correct).toBe(false)
    expect(farResult.hint).toBe('Try again')
  })

  it('handles async operations before send()', async () => {
    let fetchCount = 0
    const asyncFetch = (): Operation<{ data: string }> => ({
      *[Symbol.iterator]() {
        fetchCount++
        return { data: 'fetched' }
      },
    })

    interface FetchedHandoff {
      fetchedData: string
      timestamp: number
    }
    interface ClientAck {
      received: boolean
    }

    function* serverOp(_: unknown, ctx: ServerContextV4) {
      const { handoff, client } = yield* ctx.doClient<FetchedHandoff, ClientAck>(function* (send) {
        // Async work via Effection operation
        const result = yield* asyncFetch()
        const handoff: FetchedHandoff = {
          fetchedData: result.data,
          timestamp: Date.now(),
        }
        yield* send(handoff)
        return { handoff }
      })

      return {
        data: handoff.fetchedData,
        clientReceived: client.received,
      }
    }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V4(serverOp, {})
    })

    expect(fetchCount).toBe(1)
    expect((phase1.handoffData as FetchedHandoff).fetchedData).toBe('fetched')

    // Phase 2 - async fetch should NOT be called again
    const result = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, phase1.handoffData, { received: true })
    })

    expect(fetchCount).toBe(1) // Still 1!
    expect(result).toEqual({
      data: 'fetched',
      clientReceived: true,
    })
  })

  it('handles errors thrown before send()', async () => {
    function* serverOp(_: unknown, ctx: ServerContextV4) {
      yield* ctx.doClient<{ data: string }, { ok: boolean }>(function* (send) {
        throw new Error('Pre-send error')
        // eslint-disable-next-line no-unreachable
        yield* send({ data: 'never reached' })
        return { handoff: { data: 'never reached' } }
      })

      return { done: true }
    }

    // Phase 1 should propagate the error
    await expect(
      run(function* () {
        return yield* executePhase1V4(serverOp, {})
      })
    ).rejects.toThrow('Pre-send error')
  })

  it('handles errors thrown after doClient in phase 2', async () => {
    const shouldThrow = { value: false }

    function* serverOp(_: unknown, ctx: ServerContextV4) {
      const { handoff } = yield* ctx.doClient<{ data: string }, { ok: boolean }>(function* (send) {
        yield* send({ data: 'handoff' })
        return { handoff: { data: 'handoff' } }
      })

      if (shouldThrow.value) {
        throw new Error('Post-doClient error')
      }

      return { data: handoff.data }
    }

    // Phase 1 - no error
    const phase1 = await run(function* () {
      return yield* executePhase1V4(serverOp, {})
    })

    // Phase 2 - no error
    const result = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, phase1.handoffData, { ok: true })
    })
    expect(result).toEqual({ data: 'handoff' })

    // Phase 2 - with error
    shouldThrow.value = true
    await expect(
      run(function* () {
        return yield* executePhase2V4(serverOp, {}, phase1.handoffData, { ok: true })
      })
    ).rejects.toThrow('Post-doClient error')
  })

  it('preserves params across phases', async () => {
    interface Params {
      userId: string
      sessionId: string
    }

    function* serverOp(params: Params, ctx: ServerContextV4) {
      const { handoff, client } = yield* ctx.doClient<{ forUser: string }, { ack: boolean }>(
        function* (send) {
          yield* send({ forUser: params.userId })
          return { handoff: { forUser: params.userId } }
        }
      )

      return {
        userId: params.userId,
        sessionId: params.sessionId,
        handoffUser: handoff.forUser,
        clientAck: client.ack,
      }
    }

    const params: Params = { userId: 'u456', sessionId: 's789' }

    // Phase 1
    const phase1 = await run(function* () {
      return yield* executePhase1V4(serverOp, params)
    })

    expect(phase1.handoffData).toEqual({ forUser: 'u456' })

    // Phase 2 - same params
    const result = await run(function* () {
      return yield* executePhase2V4(serverOp, params, phase1.handoffData, { ack: true })
    })

    expect(result).toEqual({
      userId: 'u456',
      sessionId: 's789',
      handoffUser: 'u456',
      clientAck: true,
    })
  })

  it('works with multiple sequential doClient calls (only first one halts)', async () => {
    // This tests what happens if a tool tries to call doClient twice
    // The second call should never be reached in phase 1
    const firstDoClient = vi.fn()
    const secondDoClient = vi.fn()

    function* serverOp(_: unknown, ctx: ServerContextV4) {
      firstDoClient()
      const { handoff: h1, client: c1 } = yield* ctx.doClient<{ step: number }, { ok: boolean }>(
        function* (send) {
          yield* send({ step: 1 })
          return { handoff: { step: 1 } }
        }
      )

      // This would only run in phase 2
      secondDoClient()

      // NOTE: A second doClient call in the same operation is unusual
      // In phase 2, this would throw because we're not set up for multiple handoffs
      // For now, we just test that firstDoClient halts and secondDoClient never runs in phase 1

      return { step: h1.step, ok: c1.ok }
    }

    // Phase 1
    await run(function* () {
      return yield* executePhase1V4(serverOp, {})
    })

    expect(firstDoClient).toHaveBeenCalledTimes(1)
    expect(secondDoClient).not.toHaveBeenCalled()

    // Phase 2
    const result = await run(function* () {
      return yield* executePhase2V4(serverOp, {}, { step: 1 }, { ok: true })
    })

    expect(firstDoClient).toHaveBeenCalledTimes(2) // Runs again in phase 2
    expect(secondDoClient).toHaveBeenCalledTimes(1) // Now runs in phase 2
    expect(result).toEqual({ step: 1, ok: true })
  })
})
