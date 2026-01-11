/**
 * V7 Handoff - Basic Tests
 *
 * Clean tests for the V7 handoff pattern using vitest-effection adapter.
 * Demonstrates how to test isomorphic tools with generators.
 *
 * Uses the new builder API with declarative context types.
 */
import { z } from 'zod'
import { describe, it, expect } from './vitest-effection.ts'
import { createIsomorphicTool } from '../builder.ts'
import { executeServerPart, executeServerPhase2 } from '../executor.ts'
import type { AnyIsomorphicTool } from '../types.ts'

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Simple counter tool using V7 handoff.
 *
 * Phase 1: Server generates a count and timestamp
 * Phase 2: Server receives client response and computes final result
 */
const counterTool = createIsomorphicTool('counter')
  .description('A simple counter tool for testing')
  .parameters(z.object({
    start: z.number().default(0),
  }))
  .context('headless')
  .authority('server')
  .handoff({
    *before(params) {
      // This runs exactly once in phase 1
      return {
        count: params.start,
        timestamp: Date.now(),
      }
    },
    *client(handoff, _ctx, _params) {
      // Client receives handoff data from before()
      // Returns increment for after() to use
      return { increment: 1, displayed: true, receivedCount: handoff.count }
    },
    *after(handoff, client) {
      // This runs exactly once in phase 2
      return {
        originalCount: handoff.count,
        increment: client.increment,
        finalCount: handoff.count + client.increment,
        timestamp: handoff.timestamp,
      }
    },
  })

/**
 * Secret keeper tool - demonstrates caching of non-idempotent operations.
 */
const secretKeeperTool = createIsomorphicTool('secret_keeper')
  .description('Keeps a randomly generated secret')
  .parameters(z.object({}))
  .context('headless')
  .authority('server')
  .handoff({
    *before() {
      // Random secret - should only be generated once!
      const secret = Math.random().toString(36).substring(2, 10)
      return { secret }
    },
    *client(_handoff, _ctx, _params) {
      // Return a guess (in real usage this would come from UI/agent)
      return { guess: 'placeholder' }
    },
    *after(handoff, client) {
      return {
        secret: handoff.secret,
        guess: client.guess,
        correct: client.guess === handoff.secret,
      }
    },
  })

// =============================================================================
// TESTS
// =============================================================================

describe('V7 Handoff - Basic', () => {
  const signal = new AbortController().signal

  describe('two-phase execution', () => {
    it('executes before() in phase 1 and after() in phase 2', function* () {
      const tool = counterTool as unknown as AnyIsomorphicTool

      // Phase 1: Execute server part
      const phase1 = yield* executeServerPart(tool, 'call-1', { start: 10 }, signal)

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.serverOutput).toMatchObject({ count: 10 })

      // Phase 2: Complete with client output
      const result = yield* executeServerPhase2(
        tool,
        'call-1',
        { start: 10 },
        { increment: 5 }, // client output
        phase1.serverOutput, // cached handoff
        signal,
        true // usesHandoff
      )

      expect(result).toMatchObject({
        originalCount: 10,
        increment: 5,
        finalCount: 15,
      })
    })

    it('preserves before() data across phases (no re-execution)', function* () {
      const tool = secretKeeperTool as unknown as AnyIsomorphicTool

      // Phase 1: Generate random secret
      const phase1 = yield* executeServerPart(tool, 'call-1', {}, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      const secret = (phase1.serverOutput as { secret: string }).secret

      // Phase 2: Verify same secret is used
      const result = yield* executeServerPhase2(
        tool,
        'call-1',
        {},
        { guess: secret }, // Correct guess
        phase1.serverOutput,
        signal,
        true
      )

      expect(result).toMatchObject({
        secret, // Same secret from phase 1
        guess: secret,
        correct: true,
      })
    })

    it('handles incorrect guesses', function* () {
      const tool = secretKeeperTool as unknown as AnyIsomorphicTool

      const phase1 = yield* executeServerPart(tool, 'call-1', {}, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      const secret = (phase1.serverOutput as { secret: string }).secret

      const result = yield* executeServerPhase2(
        tool,
        'call-1',
        {},
        { guess: 'wrong-guess' },
        phase1.serverOutput,
        signal,
        true
      )

      expect(result).toMatchObject({
        secret, // Original secret preserved
        guess: 'wrong-guess',
        correct: false,
      })
    })
  })

  describe('handoff metadata', () => {
    it('marks handoff events with usesHandoff: true', function* () {
      const tool = counterTool as unknown as AnyIsomorphicTool
      const phase1 = yield* executeServerPart(tool, 'call-1', { start: 0 }, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.handoff.usesHandoff).toBe(true)
      expect(phase1.handoff.authority).toBe('server')
    })

    it('includes tool name and call ID in handoff event', function* () {
      const tool = counterTool as unknown as AnyIsomorphicTool
      const phase1 = yield* executeServerPart(tool, 'my-unique-call-id', { start: 0 }, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.handoff.toolName).toBe('counter')
      expect(phase1.handoff.callId).toBe('my-unique-call-id')
    })
  })

  describe('error handling', () => {
    it('propagates errors from before()', function* () {
      const errorTool = createIsomorphicTool('error_before')
        .description('Errors in before()')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before(): Generator<never, { x: number }> {
            throw new Error('before() exploded')
          },
          *client(_handoff, _ctx, _params) {
            return {}
          },
          *after(handoff) {
            return { x: handoff.x }
          },
        })

      const tool = errorTool as unknown as AnyIsomorphicTool

      let caught: Error | undefined
      try {
        yield* executeServerPart(tool, 'call-1', {}, signal)
      } catch (e) {
        caught = e as Error
      }

      expect(caught).toBeDefined()
      expect(caught?.message).toBe('before() exploded')
    })

    it('propagates errors from after()', function* () {
      const errorTool = createIsomorphicTool('error_after')
        .description('Errors in after()')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before() {
            return { x: 1 }
          },
          *client(_handoff, _ctx, _params) {
            return {}
          },
          *after(_handoff): Generator<never, { result: number }> {
            throw new Error('after() exploded')
          },
        })

      const tool = errorTool as unknown as AnyIsomorphicTool

      // Phase 1 succeeds
      const phase1 = yield* executeServerPart(tool, 'call-1', {}, signal)
      expect(phase1.kind).toBe('handoff')

      // Phase 2 throws
      let caught: Error | undefined
      try {
        yield* executeServerPhase2(
          tool,
          'call-1',
          {},
          {},
          phase1.serverOutput,
          signal,
          true
        )
      } catch (e) {
        caught = e as Error
      }

      expect(caught).toBeDefined()
      expect(caught?.message).toBe('after() exploded')
    })
  })
})

describe('Server-authority without handoff', () => {
  const signal = new AbortController().signal

  it('completes in phase 1 with usesHandoff: false', function* () {
    const simpleTool = createIsomorphicTool('simple')
      .description('Simple tool without handoff')
      .parameters(z.object({ message: z.string() }))
      .context('headless')
      .authority('server')
      .server(function* (params) {
        // No ctx.handoff() - just return directly
        return { echoed: params.message }
      })
      .client(function* (serverOutput, _ctx, _params) {
        return { displayed: true, message: (serverOutput as { echoed: string }).echoed }
      })

    const tool = simpleTool as unknown as AnyIsomorphicTool
    const phase1 = yield* executeServerPart(tool, 'call-1', { message: 'hello' }, signal)

    expect(phase1.kind).toBe('handoff')
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

    expect(phase1.usesHandoff).toBe(false)
    expect(phase1.handoff.usesHandoff).toBe(false)
    expect(phase1.serverOutput).toEqual({ echoed: 'hello' })
  })

  it('returns cached serverOutput in phase 2 (no re-execution)', function* () {
    let callCount = 0

    const countingTool = createIsomorphicTool('counting')
      .description('Counts server calls')
      .parameters(z.object({}))
      .context('headless')
      .authority('server')
      .server(function* () {
        callCount++
        return { callNumber: callCount }
      })
      .client(function* () {
        return {}
      })

    const tool = countingTool as unknown as AnyIsomorphicTool

    // Phase 1
    const phase1 = yield* executeServerPart(tool, 'call-1', {}, signal)
    expect(callCount).toBe(1)

    // Phase 2 - should NOT re-run server
    const result = yield* executeServerPhase2(
      tool,
      'call-1',
      {},
      { ack: true },
      phase1.serverOutput,
      signal,
      false // usesHandoff = false
    )

    expect(callCount).toBe(1) // Still 1!
    expect(result).toEqual({ callNumber: 1 })
  })
})

describe('Client-authority tools', () => {
  const signal = new AbortController().signal

  it('skips server execution in phase 1', function* () {
    let serverCalled = false

    const clientFirstTool = createIsomorphicTool('client_first')
      .description('Client runs first')
      .parameters(z.object({ question: z.string() }))
      .context('headless')
      .authority('client')
      .client(function* (params, _ctx) {
        return { answer: `Yes to: ${params.question}` }
      })
      .server(function* (params, _ctx, clientOutput) {
        serverCalled = true
        return {
          question: params.question,
          answer: clientOutput.answer,
          validated: true,
        }
      })

    const tool = clientFirstTool as unknown as AnyIsomorphicTool

    // Phase 1 - no server execution
    const phase1 = yield* executeServerPart(tool, 'call-1', { question: 'test?' }, signal)

    expect(serverCalled).toBe(false)
    expect(phase1.kind).toBe('handoff')
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
    expect(phase1.handoff.authority).toBe('client')
    expect(phase1.serverOutput).toBeUndefined()

    // Phase 2 - server validates
    const result = yield* executeServerPhase2(
      tool,
      'call-1',
      { question: 'test?' },
      { answer: 'Yes to: test?' },
      undefined,
      signal,
      false
    )

    expect(serverCalled).toBe(true)
    expect(result).toMatchObject({
      question: 'test?',
      answer: 'Yes to: test?',
      validated: true,
    })
  })
})
