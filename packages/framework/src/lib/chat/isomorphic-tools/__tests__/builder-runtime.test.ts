/**
 * Runtime Tests for Isomorphic Tool Builder
 *
 * These tests verify the builder produces working tools that integrate
 * with the executor.
 */
import { describe, it, expect } from './vitest-effection.ts'
import { z } from 'zod'
import { sleep } from 'effection'
import { createIsomorphicTool } from '../builder.ts'
import { executeServerPart, executeServerPhase2 } from '../executor.ts'
import { createIsomorphicToolRegistry } from '../registry.ts'
import type { AnyIsomorphicTool } from '../types.ts'

describe('Isomorphic Tool Builder Runtime', () => {
  describe('Server Authority with Handoff', () => {
    const guessNumberTool = createIsomorphicTool('guess_number')
      .description('Guess a number game')
      .parameters(z.object({ 
        max: z.number().default(100),
        prompt: z.string().optional() 
      }))
      .context('headless')
      .authority('server')
      .handoff({
        *before(params) {
          // Pick a random number (runs ONCE in phase 1)
          const secret = Math.floor(Math.random() * params.max) + 1
          return { 
            secret, 
            max: params.max,
            hint: `I picked a number between 1 and ${params.max}` 
          }
        },
        *client(handoff, _ctx, _params) {
          // Client would show UI here, we just return a guess
          yield* sleep(10)
          return { guess: Math.floor(handoff.max / 2) }
        },
        *after(handoff, client) {
          // Validate the guess (runs ONCE in phase 2)
          const isCorrect = client.guess === handoff.secret
          const diff = Math.abs(client.guess - handoff.secret)
          return {
            secret: handoff.secret,
            guess: client.guess,
            isCorrect,
            feedback: isCorrect 
              ? 'Correct!' 
              : diff <= 5 
                ? 'Very close!' 
                : 'Try again',
          }
        },
      })

    it('should execute phase 1 and return handoff data', function* () {
      // Cast to AnyIsomorphicTool for executor compatibility
      const tool = guessNumberTool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      const result = yield* executeServerPart(tool, 'call-1', { max: 10 }, signal)

      expect(result.kind).toBe('handoff')
      if (result.kind !== 'handoff') throw new Error('Expected handoff')

      expect(result.usesHandoff).toBe(true)
      expect(result.serverOutput).toBeDefined()
      expect((result.serverOutput as any).secret).toBeGreaterThanOrEqual(1)
      expect((result.serverOutput as any).secret).toBeLessThanOrEqual(10)
      expect((result.serverOutput as any).hint).toContain('1 and 10')
    })

    it('should execute phase 2 with cached handoff and client response', function* () {
      const tool = guessNumberTool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1
      const phase1 = yield* executeServerPart(tool, 'call-1', { max: 10 }, signal)

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      const cachedSecret = (phase1.serverOutput as any).secret

      // Phase 2 with client response
      // Signature: executeServerPhase2(tool, callId, params, clientOutput, cachedHandoff, signal, usesHandoff)
      const phase2 = yield* executeServerPhase2(
        tool,
        'call-1',
        { max: 10 },
        { guess: cachedSecret }, // Client guessed correctly!
        phase1.serverOutput,      // Cached handoff from phase 1
        signal,
        true                       // usesHandoff
      )

      // executeServerPhase2 returns the result directly, not an object with ok/result
      expect((phase2 as any).secret).toBe(cachedSecret)
      expect((phase2 as any).guess).toBe(cachedSecret)
      expect((phase2 as any).isCorrect).toBe(true)
      expect((phase2 as any).feedback).toBe('Correct!')
    })

    it('should preserve secret across phases (idempotency)', function* () {
      const tool = guessNumberTool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Run phase 1 multiple times - each should get DIFFERENT secrets
      const collectedSecrets: number[] = []
       for (let i = 0; i < 3; i++) {
         const phase1 = yield* executeServerPart(tool, `call-${i}`, { max: 1000 }, signal)
         if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
         collectedSecrets.push((phase1.serverOutput as any).secret)
       }


      // But when we re-run with cached handoff, secret is preserved
      const originalSecret = 42
      const cachedHandoff = { secret: originalSecret, max: 100, hint: 'test' }

      const phase2 = yield* executeServerPhase2(
        tool,
        'call-preserved',
        { max: 100 },
        { guess: 50 },  // clientOutput
        cachedHandoff,  // cached handoff from phase 1
        signal,
        true            // usesHandoff
      )

      // Phase 2 uses the CACHED secret, not a new one
      expect((phase2 as any).secret).toBe(42)
    })
  })

  describe('Tool Properties', () => {
    it('should have correct name and description', function* () {
      const tool = createIsomorphicTool('my_tool')
        .description('A test tool')
        .parameters(z.object({ x: z.number() }))
        .context('headless')
        .authority('server')
        .server(function*(params) { return { doubled: params.x * 2 } })
        .build()

      expect(tool.name).toBe('my_tool')
      expect(tool.description).toBe('A test tool')
      expect(tool.authority).toBe('server')
    })

    it('should store handoffConfig for handoff tools', function* () {
      const tool = createIsomorphicTool('handoff_tool')
        .description('Has handoff')
        .parameters(z.object({ input: z.string() }))
        .context('headless')
        .authority('server')
        .handoff({
          *before() { return { data: 'test' } },
          *client() { return { ack: true } },
          *after() { return { done: true } },
        })

      expect(tool.handoffConfig).toBeDefined()
      expect(typeof tool.handoffConfig!.before).toBe('function')
      expect(typeof tool.handoffConfig!.client).toBe('function')
      expect(typeof tool.handoffConfig!.after).toBe('function')
    })
  })

  describe('Client Authority (client-only build)', () => {
    it('should passthrough client output if server is omitted', function* () {
      const tool = createIsomorphicTool('client_only_passthrough')
        .description('Client only')
        .parameters(z.object({ prompt: z.string() }))
        .context('headless')
        .authority('client')
        .client(function*(params) {
          return { echoed: params.prompt }
        })
        .build()

      // Cast to AnyIsomorphicTool for executor compatibility
      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1: server should immediately handoff (client authority)
      const phase1 = yield* executeServerPart(anyTool, 'call-client-only', { prompt: 'hi' }, signal)

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(false)
      expect(phase1.handoff.authority).toBe('client')
      expect(phase1.handoff.serverOutput).toBeUndefined()

      // Phase 2: server passthrough should return client output
      const phase2 = yield* executeServerPhase2(
        anyTool,
        'call-client-only',
        { prompt: 'hi' },
        { echoed: 'hi' },
        undefined,
        signal,
        false
      )

      expect(phase2).toEqual({ echoed: 'hi' })
    })
  })

  describe('Registry Integration', () => {
    it('should work with createIsomorphicToolRegistry', function* () {
      const tool1 = createIsomorphicTool('tool_a')
        .description('Tool A')
        .parameters(z.object({ a: z.string() }))
        .context('headless')
        .authority('server')
        .server(function*() { return { result: 'a' } })
        .build()

      const tool2 = createIsomorphicTool('tool_b')
        .description('Tool B')
        .parameters(z.object({ b: z.number() }))
        .context('headless')
        .authority('client')
        .client(function*() { return { choice: 'x' } })
        .server(function*(_params, _ctx, client) { return { validated: true, choice: client.choice } })

      // Cast to AnyIsomorphicTool for registry
      const registry = createIsomorphicToolRegistry([
        tool1 as unknown as AnyIsomorphicTool,
        tool2 as unknown as AnyIsomorphicTool,
      ])

      expect(registry.has('tool_a')).toBe(true)
      expect(registry.has('tool_b')).toBe(true)
      expect(registry.names()).toContain('tool_a')
      expect(registry.names()).toContain('tool_b')
    })
  })
})
