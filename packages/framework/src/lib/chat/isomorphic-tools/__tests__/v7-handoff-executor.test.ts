/**
 * V7 Handoff Executor Integration Tests
 *
 * Tests the V7 handoff pattern integrated with the actual executor functions.
 * This verifies that the handoff({ before, after }) API works correctly with
 * executeServerPart() and executeServerPhase2().
 *
 * ## The V7 Pattern
 *
 * Server-authority tools can use ctx.handoff() to yield to the client:
 *
 * ```typescript
 * *server(params, ctx) {
 *   return yield* ctx.handoff({
 *     *before() {
 *       const secret = expensiveCompute()  // Only runs in phase 1
 *       return { secret, hint: '...' }
 *     },
 *     *after(handoff, client: { guess: string }) {
 *       return {                            // Only runs in phase 2
 *         secret: handoff.secret,
 *         correct: client.guess === handoff.secret,
 *       }
 *     },
 *   })
 * }
 * ```
 *
 * ## Execution Phases
 *
 * Phase 1 (executeServerPart):
 * - Creates phase 1 context where handoff() runs before() and throws HandoffReadyError
 * - Catches the error and returns { handoff, serverOutput, usesHandoff: true }
 *
 * Phase 2 (executeServerPhase2):
 * - Creates phase 2 context where handoff() skips before() and runs after()
 * - Returns the final result for the LLM
 *
 * ## Key Guarantees
 *
 * - before() only runs once (in phase 1)
 * - after() only runs once (in phase 2)
 * - Expensive/non-idempotent code in before() is safe
 * - ONE handoff per tool (documented limitation)
 */
import { describe, it, expect, vi } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { defineIsomorphicTool } from '../define'
import { executeServerPart, executeServerPhase2 } from '../executor'
import type { ServerAuthorityContext } from '../types'
import { guessTheCardTool } from './-tools'

describe('V7 Handoff Executor Integration', () => {
  describe('server-authority tool WITH handoff', () => {
    it('should halt at handoff in phase 1 and resume in phase 2', async () => {
      const beforeFn = vi.fn()
      const afterFn = vi.fn()

      const tool = defineIsomorphicTool({
        name: 'test_handoff',
        description: 'Test tool with handoff',
        parameters: z.object({ name: z.string() }),
        authority: 'server',

        *server(params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              beforeFn()
              return { secret: 42, player: params.name }
            },
            *after(handoff, client: { guess: number }) {
              afterFn()
              return {
                player: handoff.player,
                secret: handoff.secret,
                guess: client.guess,
                correct: client.guess === handoff.secret,
              }
            },
          })
        },

        *client(serverOutput, _ctx, _params) {
          return { displayed: true, received: serverOutput }
        },
      })

      const signal = new AbortController().signal

      // Phase 1: Execute and halt at handoff
      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', { name: 'Alice' }, signal)
      })

      expect(beforeFn).toHaveBeenCalledTimes(1)
      expect(afterFn).not.toHaveBeenCalled()

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.handoff.usesHandoff).toBe(true)
      expect(phase1.serverOutput).toEqual({ secret: 42, player: 'Alice' })

      // Phase 2: Resume with client output
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          { name: 'Alice' },
          { guess: 42 }, // client output
          phase1.serverOutput, // cached handoff
          signal,
          true // usesHandoff
        )
      })

      expect(beforeFn).toHaveBeenCalledTimes(1) // Still 1! Not re-run
      expect(afterFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        player: 'Alice',
        secret: 42,
        guess: 42,
        correct: true,
      })
    })

    it('should NOT re-run expensive computation in phase 2', async () => {
      let computeCount = 0

      const tool = defineIsomorphicTool({
        name: 'expensive_tool',
        description: 'Tool with expensive computation',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              computeCount++
              return { computed: `result-${computeCount}` }
            },
            *after(handoff, client: { ack: boolean }) {
              return { value: handoff.computed, ack: client.ack }
            },
          })
        },

        *client() {
          return {}
        },
      })

      const signal = new AbortController().signal

      // Phase 1
      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', {}, signal)
      })
      expect(computeCount).toBe(1)
      expect(phase1.serverOutput).toEqual({ computed: 'result-1' })

      // Phase 2 - computation should NOT run again
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          {},
          { ack: true },
          phase1.serverOutput,
          signal,
          true
        )
      })

      expect(computeCount).toBe(1) // Still 1!
      expect(result).toEqual({ value: 'result-1', ack: true })
    })

    it('should handle incorrect guess correctly', async () => {
      const tool = defineIsomorphicTool({
        name: 'guess_game',
        description: 'Guessing game',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              return { secret: 'apple' }
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

      const signal = new AbortController().signal

      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', {}, signal)
      })

      // Wrong guess
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          {},
          { guess: 'banana' },
          phase1.serverOutput,
          signal,
          true
        )
      })

      expect(result).toEqual({
        secret: 'apple',
        guess: 'banana',
        correct: false,
      })
    })

    it('should propagate errors from before()', async () => {
      const tool = defineIsomorphicTool({
        name: 'error_before',
        description: 'Tool that errors in before',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before(): Generator<never, { x: number }> {
              throw new Error('before() failed')
            },
            *after(handoff) {
              return { result: handoff.x }
            },
          })
        },

        *client() {
          return { displayed: true }
        },
      })

      const signal = new AbortController().signal

      await expect(
        run(function*() {
          return yield* executeServerPart(tool, 'call-1', {}, signal)
        })
      ).rejects.toThrow('before() failed')
    })

    it('should propagate errors from after()', async () => {
      const tool = defineIsomorphicTool({
        name: 'error_after',
        description: 'Tool that errors in after',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              return { x: 1 }
            },
            *after(_handoff): Generator<never, { result: number }> {
              throw new Error('after() failed')
            },
          })
        },

        *client() {
          return { displayed: true }
        },
      })

      const signal = new AbortController().signal

      // Phase 1 should succeed
      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', {}, signal)
      })
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      expect(phase1.usesHandoff).toBe(true)

      // Phase 2 should fail
      await expect(
        run(function*() {
          return yield* executeServerPhase2(
            tool,
            'call-1',
            {},
            {},
            phase1.serverOutput,
            signal,
            true
          )
        })
      ).rejects.toThrow('after() failed')
    })
  })

  describe('server-authority tool WITHOUT handoff (simple)', () => {
    it('should complete in phase 1 with usesHandoff=false', async () => {
      const tool = defineIsomorphicTool({
        name: 'simple_server',
        description: 'Simple server tool without handoff',
        parameters: z.object({ message: z.string() }),
        authority: 'server',

        *server({ message }) {
          return { celebrated: true, message }
        },

        *client(serverOutput) {
          return { displayed: true, message: serverOutput.message }
        },
      })

      const signal = new AbortController().signal

      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', { message: 'Hello!' }, signal)
      })

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(false)
      expect(phase1.handoff.usesHandoff).toBe(false)
      expect(phase1.serverOutput).toEqual({ celebrated: true, message: 'Hello!' })
    })

    it('should return cached serverOutput in phase 2 for simple tools', async () => {
      const serverFn = vi.fn()

      const tool = defineIsomorphicTool({
        name: 'simple_server',
        description: 'Simple server tool',
        parameters: z.object({}),
        authority: 'server',

        *server() {
          serverFn()
          return { result: 'computed' }
        },

        *client() {
          return {}
        },
      })

      const signal = new AbortController().signal

      // Phase 1
      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', {}, signal)
      })
      expect(serverFn).toHaveBeenCalledTimes(1)
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      expect(phase1.usesHandoff).toBe(false)

      // Phase 2 - should just return cached output, NOT re-run server
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          {},
          { clientData: true },
          phase1.serverOutput,
          signal,
          false // usesHandoff = false
        )
      })

      expect(serverFn).toHaveBeenCalledTimes(1) // Still 1!
      expect(result).toEqual({ result: 'computed' })
    })
  })

  describe('client-authority tool', () => {
    it('should skip phase 1 server execution and run in phase 2', async () => {
      const serverFn = vi.fn()

      const tool = defineIsomorphicTool({
        name: 'client_first',
        description: 'Client authority tool',
        parameters: z.object({ question: z.string() }),
        authority: 'client',

        *client(params) {
          return { answer: `Response to: ${params.question}` }
        },

        *server(params, _ctx, clientOutput) {
          serverFn()
          return {
            question: params.question,
            answer: clientOutput!.answer,
            validated: true,
          }
        },
      })

      const signal = new AbortController().signal

      // Phase 1 - no server code runs for client authority
      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', { question: 'What is 2+2?' }, signal)
      })

      expect(serverFn).not.toHaveBeenCalled()

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(false)
      expect(phase1.serverOutput).toBeUndefined()
      expect(phase1.handoff.authority).toBe('client')

      // Phase 2 - server validates client output
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          { question: 'What is 2+2?' },
          { answer: '4' }, // client output
          undefined,
          signal,
          false
        )
      })

      expect(serverFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        question: 'What is 2+2?',
        answer: '4',
        validated: true,
      })
    })
  })

  describe('complex scenarios', () => {
    it('should handle async operations in before()', async () => {
      let fetchCount = 0

      const tool = defineIsomorphicTool({
        name: 'async_before',
        description: 'Tool with async before',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              // Simulate async fetch
              fetchCount++
              yield* (function*() {
                return 'fetched'
              })()
              return { data: `fetch-${fetchCount}` }
            },
            *after(handoff, client: { ok: boolean }) {
              return { data: handoff.data, clientOk: client.ok }
            },
          })
        },

        *client() {
          return {}
        },
      })

      const signal = new AbortController().signal

      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', {}, signal)
      })
      expect(fetchCount).toBe(1)

      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          {},
          { ok: true },
          phase1.serverOutput,
          signal,
          true
        )
      })

      expect(fetchCount).toBe(1) // Still 1!
      expect(result).toEqual({ data: 'fetch-1', clientOk: true })
    })

    it('should handle complex data structures in handoff', async () => {
      interface Card {
        suit: string
        rank: string
      }

      const tool = defineIsomorphicTool({
        name: 'card_game',
        description: 'Card game tool',
        parameters: z.object({ difficulty: z.string() }),
        authority: 'server',

        *server(params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              const cards: Card[] = [
                { suit: 'hearts', rank: 'A' },
                { suit: 'spades', rank: 'K' },
              ]
              return {
                secret: cards[0],
                options: cards,
                difficulty: params.difficulty,
              }
            },
            *after(handoff, client: { selectedIndex: number }) {
              const selected = handoff.options[client.selectedIndex]
              return {
                secret: handoff.secret,
                selected,
                correct:
                  selected?.suit === handoff.secret.suit &&
                  selected?.rank === handoff.secret.rank,
              }
            },
          })
        },

        *client() {
          return {}
        },
      })

      const signal = new AbortController().signal

      const phase1 = await run(function*() {
        return yield* executeServerPart(tool, 'call-1', { difficulty: 'hard' }, signal)
      })

      expect(phase1.serverOutput).toEqual({
        secret: { suit: 'hearts', rank: 'A' },
        options: [
          { suit: 'hearts', rank: 'A' },
          { suit: 'spades', rank: 'K' },
        ],
        difficulty: 'hard',
      })

      // Correct guess
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          { difficulty: 'hard' },
          { selectedIndex: 0 },
          phase1.serverOutput,
          signal,
          true
        )
      })

      expect(result).toEqual({
        secret: { suit: 'hearts', rank: 'A' },
        selected: { suit: 'hearts', rank: 'A' },
        correct: true,
      })
    })

    it('should handle code after handoff() that only runs in phase 2', async () => {
      const afterHandoffFn = vi.fn()

      const tool = defineIsomorphicTool({
        name: 'post_handoff',
        description: 'Tool with code after handoff',
        parameters: z.object({}),
        authority: 'server',

        *server(_params, ctx: ServerAuthorityContext) {
          const result = yield* ctx.handoff({
            *before() {
              return { x: 1 }
            },
            *after(handoff, client: { y: number }) {
              return { x: handoff.x, y: client.y }
            },
          })

          // This only runs in phase 2!
          afterHandoffFn(result)

          return { ...result, postProcessed: true }
        },

        *client() {
          return {}
        },
      })

      const signal = new AbortController().signal

      // Phase 1 - afterHandoffFn should NOT run
      await run(function*() {
        return yield* executeServerPart(tool, 'call-1', {}, signal)
      })
      expect(afterHandoffFn).not.toHaveBeenCalled()

      // Phase 2 - afterHandoffFn SHOULD run
      const result = await run(function*() {
        return yield* executeServerPhase2(
          tool,
          'call-1',
          {},
          { y: 2 },
          { x: 1 },
          signal,
          true
        )
      })

      expect(afterHandoffFn).toHaveBeenCalledTimes(1)
      expect(afterHandoffFn).toHaveBeenCalledWith({ x: 1, y: 2 })
      expect(result).toEqual({ x: 1, y: 2, postProcessed: true })
    })
  })

  describe('guessTheCardTool (real V7 tool)', () => {
    it('should pick a card in phase 1 and validate guess in phase 2', async () => {
      const signal = new AbortController().signal

      // Phase 1: Pick the secret card and generate choices
      const phase1 = await run(function*() {
        return yield* executeServerPart(
          guessTheCardTool,
          'call-1',
          { prompt: 'Which card?', numChoices: 4 },
          signal
        )
      })

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') {
        throw new Error('Expected handoff result')
      }

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.handoff.usesHandoff).toBe(true)
      expect(phase1.handoff.authority).toBe('server')

      // Verify handoff data structure
      const handoffData = phase1.serverOutput as {
        secret: string
        secretColor: string
        choices: string[]
        hint: string
        prompt: string
      }
      expect(handoffData.secret).toBeDefined()
      expect(handoffData.secretColor).toMatch(/^(red|black)$/)
      expect(handoffData.choices).toHaveLength(4)
      expect(handoffData.choices).toContain(handoffData.secret) // Secret is among choices
      expect(handoffData.hint).toMatch(/thinking of a (red|black) card/)
      expect(handoffData.prompt).toBe('Which card?')

      // Phase 2: User guesses correctly
      const correctResult = await run(function*() {
        return yield* executeServerPhase2(
          guessTheCardTool,
          'call-1',
          { prompt: 'Which card?', numChoices: 4 },
          { guess: handoffData.secret }, // Correct guess!
          phase1.serverOutput,
          signal,
          true
        )
      }) as {
        guess: string
        secret: string
        isCorrect: boolean
        feedback: string
        hint: string
        guessNumber: number
      }

      expect(correctResult.guess).toBe(handoffData.secret)
      expect(correctResult.secret).toBe(handoffData.secret)
      expect(correctResult.isCorrect).toBe(true)
      expect(correctResult.feedback).toContain('correctly guessed')
    })

    it('should detect incorrect guess in phase 2', async () => {
      const signal = new AbortController().signal

      // Phase 1
      const phase1 = await run(function*() {
        return yield* executeServerPart(
          guessTheCardTool,
          'call-2',
          {},
          signal
        )
      })

      const handoffData = phase1.serverOutput as {
        secret: string
        choices: string[]
      }

      // Find a wrong choice
      const wrongGuess = handoffData.choices.find(c => c !== handoffData.secret)!

      // Phase 2: User guesses incorrectly
      const result = await run(function*() {
        return yield* executeServerPhase2(
          guessTheCardTool,
          'call-2',
          {},
          { guess: wrongGuess },
          phase1.serverOutput,
          signal,
          true
        )
      }) as {
        guess: string
        secret: string
        isCorrect: boolean
        feedback: string
      }

      expect(result.isCorrect).toBe(false)
      expect(result.guess).toBe(wrongGuess)
      expect(result.secret).toBe(handoffData.secret)
      expect(result.feedback).toMatch(/Not quite|Close/)
    })

    it('should preserve secret across phases (idempotency)', async () => {
      const signal = new AbortController().signal

      // Run phase 1 twice - should get different secrets each time
      // (proving phase 1 actually picks)
      const run1 = await run(function*() {
        return yield* executeServerPart(guessTheCardTool, 'call-a', {}, signal)
      })

      const run2 = await run(function*() {
        return yield* executeServerPart(guessTheCardTool, 'call-b', {}, signal)
      })

      // These MIGHT be the same (52 cards), but the point is they're independent
      // The key test is that phase 2 uses cached data, not a new pick

      const secret1 = (run1.serverOutput as { secret: string }).secret
      const secret2 = (run2.serverOutput as { secret: string }).secret

      // Now run phase 2 for run1 with the wrong secret from run2
      // It should validate against run1's secret, not a new pick
      const result = await run(function*() {
        return yield* executeServerPhase2(
          guessTheCardTool,
          'call-a',
          {},
          { guess: secret2 },
          run1.serverOutput, // Using run1's cached handoff
          signal,
          true
        )
      }) as { secret: string; isCorrect: boolean }

      // Result should use run1's secret (from cache), not pick a new one
      expect(result.secret).toBe(secret1)

      // If secrets differ, guess is wrong; if same, correct
      expect(result.isCorrect).toBe(secret1 === secret2)
    })
  })
})
