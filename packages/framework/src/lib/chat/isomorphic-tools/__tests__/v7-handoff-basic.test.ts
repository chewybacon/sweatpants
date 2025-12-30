/**
 * V7 Handoff - Basic Tests
 *
 * Clean tests for the V7 handoff pattern using vitest-effection adapter.
 * Demonstrates how to test isomorphic tools with generators.
 */
import { z } from 'zod'
import { describe, it, expect } from './vitest-effection'
import { defineIsomorphicTool } from '../define'
import { executeServerPart, executeServerPhase2 } from '../executor'
import type { ServerAuthorityContext } from '../types'

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Simple counter tool using V7 handoff.
 *
 * Phase 1: Server generates a count and timestamp
 * Phase 2: Server receives client response and computes final result
 */
const counterTool = defineIsomorphicTool({
  name: 'counter',
  description: 'A simple counter tool for testing',
  parameters: z.object({
    start: z.number().default(0),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        // This runs exactly once in phase 1
        return {
          count: params.start,
          timestamp: Date.now(),
        }
      },
      *after(handoff, client: { increment: number }) {
        // This runs exactly once in phase 2
        return {
          originalCount: handoff.count,
          increment: client.increment,
          finalCount: handoff.count + client.increment,
          timestamp: handoff.timestamp,
        }
      },
    })
  },

  *client(handoffData, _ctx, _params) {
    // Client receives handoff data from before()
    // Cast because TypeScript infers TServerOutput as after()'s return type
    const data = handoffData as unknown as { count: number; timestamp: number }
    return { displayed: true, receivedCount: data.count }
  },
})

/**
 * Secret keeper tool - demonstrates caching of non-idempotent operations.
 */
const secretKeeperTool = defineIsomorphicTool({
  name: 'secret_keeper',
  description: 'Keeps a randomly generated secret',
  parameters: z.object({}),
  authority: 'server',

  *server(_params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        // Random secret - should only be generated once!
        const secret = Math.random().toString(36).substring(2, 10)
        return { secret }
      },
      *after(handoff, client: { guess: string }) {
        return {
          secret: handoff.secret,
          guess: client.guess,
          correct: client.guess === handoff.secret,
        }
      },
    })
  },

  *client() {
    return {}
  },
})

// =============================================================================
// TESTS
// =============================================================================

describe('V7 Handoff - Basic', () => {
  const signal = new AbortController().signal

  describe('two-phase execution', () => {
    it('executes before() in phase 1 and after() in phase 2', function* () {
      // Phase 1: Execute server part
      const phase1 = yield* executeServerPart(counterTool, 'call-1', { start: 10 }, signal)

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.serverOutput).toMatchObject({ count: 10 })

      // Phase 2: Complete with client output
      const result = yield* executeServerPhase2(
        counterTool,
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
      // Phase 1: Generate random secret
      const phase1 = yield* executeServerPart(secretKeeperTool, 'call-1', {}, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      const secret = (phase1.serverOutput as { secret: string }).secret

      // Phase 2: Verify same secret is used
      const result = yield* executeServerPhase2(
        secretKeeperTool,
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
      const phase1 = yield* executeServerPart(secretKeeperTool, 'call-1', {}, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      const secret = (phase1.serverOutput as { secret: string }).secret

      const result = yield* executeServerPhase2(
        secretKeeperTool,
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
      const phase1 = yield* executeServerPart(counterTool, 'call-1', { start: 0 }, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.handoff.usesHandoff).toBe(true)
      expect(phase1.handoff.authority).toBe('server')
    })

    it('includes tool name and call ID in handoff event', function* () {
      const phase1 = yield* executeServerPart(counterTool, 'my-unique-call-id', { start: 0 }, signal)

      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.handoff.toolName).toBe('counter')
      expect(phase1.handoff.callId).toBe('my-unique-call-id')
    })
  })

  describe('error handling', () => {
    it('propagates errors from before()', function* () {
      const errorTool = defineIsomorphicTool({
        name: 'error_before',
        description: 'Errors in before()',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before(): Generator<never, { x: number }> {
              throw new Error('before() exploded')
            },
            *after(handoff) {
              return { x: handoff.x }
            },
          })
        },

        *client() {
          return {}
        },
      })

      let caught: Error | undefined
      try {
        yield* executeServerPart(errorTool, 'call-1', {}, signal)
      } catch (e) {
        caught = e as Error
      }

      expect(caught).toBeDefined()
      expect(caught?.message).toBe('before() exploded')
    })

    it('propagates errors from after()', function* () {
      const errorTool = defineIsomorphicTool({
        name: 'error_after',
        description: 'Errors in after()',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              return { x: 1 }
            },
            *after(_handoff): Generator<never, { result: number }> {
              throw new Error('after() exploded')
            },
          })
        },

        *client() {
          return {}
        },
      })

      // Phase 1 succeeds
      const phase1 = yield* executeServerPart(errorTool, 'call-1', {}, signal)
      expect(phase1.kind).toBe('handoff')

      // Phase 2 throws
      let caught: Error | undefined
      try {
        yield* executeServerPhase2(
          errorTool,
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
    const simpleTool = defineIsomorphicTool({
      name: 'simple',
      description: 'Simple tool without handoff',
      parameters: z.object({ message: z.string() }),
      authority: 'server',

      *server({ message }) {
        // No ctx.handoff() - just return directly
        return { echoed: message }
      },

      *client(serverOutput) {
        return { displayed: true, message: serverOutput.echoed }
      },
    })

    const phase1 = yield* executeServerPart(simpleTool, 'call-1', { message: 'hello' }, signal)

    expect(phase1.kind).toBe('handoff')
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

    expect(phase1.usesHandoff).toBe(false)
    expect(phase1.handoff.usesHandoff).toBe(false)
    expect(phase1.serverOutput).toEqual({ echoed: 'hello' })
  })

  it('returns cached serverOutput in phase 2 (no re-execution)', function* () {
    let callCount = 0

    const countingTool = defineIsomorphicTool({
      name: 'counting',
      description: 'Counts server calls',
      parameters: z.object({}),
      authority: 'server',

      *server() {
        callCount++
        return { callNumber: callCount }
      },

      *client() {
        return {}
      },
    })

    // Phase 1
    const phase1 = yield* executeServerPart(countingTool, 'call-1', {}, signal)
    expect(callCount).toBe(1)

    // Phase 2 - should NOT re-run server
    const result = yield* executeServerPhase2(
      countingTool,
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

    const clientFirstTool = defineIsomorphicTool({
      name: 'client_first',
      description: 'Client runs first',
      parameters: z.object({ question: z.string() }),
      authority: 'client',

      *client(params) {
        return { answer: `Yes to: ${params.question}` }
      },

      *server(params, _ctx, clientOutput) {
        serverCalled = true
        return {
          question: params.question,
          answer: clientOutput!.answer,
          validated: true,
        }
      },
    })

    // Phase 1 - no server execution
    const phase1 = yield* executeServerPart(clientFirstTool, 'call-1', { question: 'test?' }, signal)

    expect(serverCalled).toBe(false)
    expect(phase1.kind).toBe('handoff')
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
    expect(phase1.handoff.authority).toBe('client')
    expect(phase1.serverOutput).toBeUndefined()

    // Phase 2 - server validates
    const result = yield* executeServerPhase2(
      clientFirstTool,
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
