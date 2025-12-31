/**
 * V7 Handoff Executor Integration Tests
 *
 * Tests the V7 handoff pattern integrated with the actual executor functions.
 * This verifies that the handoff({ before, after }) API works correctly with
 * executeServerPart() and executeServerPhase2().
 *
 * Uses the new builder API with declarative context types.
 */
import { describe, it, expect, vi } from 'vitest'
import { run, sleep } from 'effection'
import { z } from 'zod'
import { createIsomorphicTool } from '../builder'
import { executeServerPart, executeServerPhase2 } from '../executor'
import type { AnyIsomorphicTool } from '../types'

// =============================================================================
// TEST FIXTURES
// =============================================================================

// Card helpers for the guessTheCard test
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

type Card = { suit: (typeof SUITS)[number]; rank: (typeof RANKS)[number] }

function randomCard(): Card {
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)]
  const rank = RANKS[Math.floor(Math.random() * RANKS.length)]
  return { suit, rank }
}

function cardName(card: Card): string {
  return `${card.rank} of ${card.suit}`
}

function cardColor(card: Card): 'red' | 'black' {
  return card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black'
}

function generateCardChoices(secret: Card, numChoices: number): Card[] {
  const choices = [secret]
  while (choices.length < numChoices) {
    const card = randomCard()
    if (!choices.some(c => c.suit === card.suit && c.rank === card.rank)) {
      choices.push(card)
    }
  }
  // Shuffle
  return choices.sort(() => Math.random() - 0.5)
}

/**
 * guessTheCardTool - V7 handoff pattern with builder API
 */
const guessTheCardTool = createIsomorphicTool('guess_the_card')
  .description('A complete card guessing game in one call')
  .parameters(z.object({
    prompt: z.string().optional(),
    numChoices: z.number().min(2).max(10).optional(),
  }))
  .context('headless')
  .authority('server')
  .handoff({
    *before(params) {
      yield* sleep(50) // Short pause

      const secret = randomCard()
      const choices = generateCardChoices(secret, params.numChoices ?? 4)
      const choiceNames = choices.map(c => cardName(c))
      const hint = `I'm thinking of a ${cardColor(secret)} card...`

      return {
        secret: cardName(secret),
        secretColor: cardColor(secret),
        choices: choiceNames,
        hint,
        prompt: params.prompt ?? 'Which card am I thinking of?',
      }
    },
    *client(_handoff, _ctx, _params) {
      // In real usage, would get user input here
      return { guess: 'placeholder' }
    },
    *after(handoff, clientOutput) {
      const isCorrect = clientOutput.guess === handoff.secret

      let feedback: string
      if (isCorrect) {
        feedback = `Incredible! You correctly guessed the ${handoff.secret}!`
      } else {
        const guessColor = clientOutput.guess.includes('hearts') || clientOutput.guess.includes('diamonds') ? 'red' : 'black'
        if (guessColor !== handoff.secretColor) {
          feedback = `Not quite! You guessed a ${guessColor} card, but the secret was a ${handoff.secretColor} card: ${handoff.secret}`
        } else {
          feedback = `Close! The ${clientOutput.guess} is also ${handoff.secretColor}, but the secret was ${handoff.secret}`
        }
      }

      return {
        guess: clientOutput.guess,
        secret: handoff.secret,
        isCorrect,
        feedback,
        hint: handoff.hint,
        guessNumber: 1,
      }
    },
  })

// =============================================================================
// TESTS
// =============================================================================

describe('V7 Handoff Executor Integration', () => {
  describe('server-authority tool WITH handoff', () => {
    it('should halt at handoff in phase 1 and resume in phase 2', async () => {
      const beforeFn = vi.fn()
      const afterFn = vi.fn()

      const tool = createIsomorphicTool('test_handoff')
        .description('Test tool with handoff')
        .parameters(z.object({ name: z.string() }))
        .context('headless')
        .authority('server')
        .handoff({
          *before(params) {
            beforeFn()
            return { secret: 42, player: params.name }
          },
          *client(_handoff, _ctx, _params) {
            return { guess: 0 }
          },
          *after(handoff, client) {
            afterFn()
            return {
              player: handoff.player,
              secret: handoff.secret,
              guess: client.guess,
              correct: client.guess === handoff.secret,
            }
          },
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1: Execute and halt at handoff
      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', { name: 'Alice' }, signal)
      })

      expect(beforeFn).toHaveBeenCalledTimes(1)
      expect(afterFn).not.toHaveBeenCalled()

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(true)
      expect(phase1.handoff.usesHandoff).toBe(true)
      expect(phase1.serverOutput).toEqual({ secret: 42, player: 'Alice' })

      // Phase 2: Resume with client output
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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

      const tool = createIsomorphicTool('expensive_tool')
        .description('Tool with expensive computation')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before() {
            computeCount++
            return { computed: `result-${computeCount}` }
          },
          *client(_handoff, _ctx, _params) {
            return { ack: true }
          },
          *after(handoff, client) {
            return { value: handoff.computed, ack: client.ack }
          },
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1
      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', {}, signal)
      })
      expect(computeCount).toBe(1)
      expect(phase1.serverOutput).toEqual({ computed: 'result-1' })

      // Phase 2 - computation should NOT run again
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
      const tool = createIsomorphicTool('guess_game')
        .description('Guessing game')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before() {
            return { secret: 'apple' }
          },
          *client(_handoff, _ctx, _params) {
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

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', {}, signal)
      })

      // Wrong guess
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
      const tool = createIsomorphicTool('error_before')
        .description('Tool that errors in before')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before(): Generator<never, { x: number }> {
            throw new Error('before() failed')
          },
          *client(_handoff, _ctx, _params) {
            return {}
          },
          *after(handoff) {
            return { result: handoff.x }
          },
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      await expect(
        run(function* () {
          return yield* executeServerPart(anyTool, 'call-1', {}, signal)
        })
      ).rejects.toThrow('before() failed')
    })

    it('should propagate errors from after()', async () => {
      const tool = createIsomorphicTool('error_after')
        .description('Tool that errors in after')
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
            throw new Error('after() failed')
          },
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1 should succeed
      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', {}, signal)
      })
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      expect(phase1.usesHandoff).toBe(true)

      // Phase 2 should fail
      await expect(
        run(function* () {
          return yield* executeServerPhase2(
            anyTool,
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
      const tool = createIsomorphicTool('simple_server')
        .description('Simple server tool without handoff')
        .parameters(z.object({ message: z.string() }))
        .context('headless')
        .authority('server')
        .server(function* (params) {
          return { celebrated: true, message: params.message }
        })
        .client(function* (serverOutput, _ctx, _params) {
          return { displayed: true, message: (serverOutput as { message: string }).message }
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', { message: 'Hello!' }, signal)
      })

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(false)
      expect(phase1.handoff.usesHandoff).toBe(false)
      expect(phase1.serverOutput).toEqual({ celebrated: true, message: 'Hello!' })
    })

    it('should return cached serverOutput in phase 2 for simple tools', async () => {
      const serverFn = vi.fn()

      const tool = createIsomorphicTool('simple_server')
        .description('Simple server tool')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .server(function* () {
          serverFn()
          return { result: 'computed' }
        })
        .client(function* () {
          return {}
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1
      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', {}, signal)
      })
      expect(serverFn).toHaveBeenCalledTimes(1)
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
      expect(phase1.usesHandoff).toBe(false)

      // Phase 2 - should just return cached output, NOT re-run server
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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

      const tool = createIsomorphicTool('client_first')
        .description('Client authority tool')
        .parameters(z.object({ question: z.string() }))
        .context('headless')
        .authority('client')
        .client(function* (params, _ctx) {
          return { answer: `Response to: ${params.question}` }
        })
        .server(function* (params, _ctx, clientOutput) {
          serverFn()
          return {
            question: params.question,
            answer: clientOutput.answer,
            validated: true,
          }
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1 - no server code runs for client authority
      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', { question: 'What is 2+2?' }, signal)
      })

      expect(serverFn).not.toHaveBeenCalled()

      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      expect(phase1.usesHandoff).toBe(false)
      expect(phase1.serverOutput).toBeUndefined()
      expect(phase1.handoff.authority).toBe('client')

      // Phase 2 - server validates client output
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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

      const tool = createIsomorphicTool('async_before')
        .description('Tool with async before')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before() {
            // Simulate async fetch
            fetchCount++
            yield* sleep(10)
            return { data: `fetch-${fetchCount}` }
          },
          *client(_handoff, _ctx, _params) {
            return { ok: true }
          },
          *after(handoff, client) {
            return { data: handoff.data, clientOk: client.ok }
          },
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', {}, signal)
      })
      expect(fetchCount).toBe(1)

      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
      interface CardType {
        suit: string
        rank: string
      }

      const tool = createIsomorphicTool('card_game')
        .description('Card game tool')
        .parameters(z.object({ difficulty: z.string() }))
        .context('headless')
        .authority('server')
        .handoff({
          *before(params) {
            const cards: CardType[] = [
              { suit: 'hearts', rank: 'A' },
              { suit: 'spades', rank: 'K' },
            ]
            return {
              secret: cards[0],
              options: cards,
              difficulty: params.difficulty,
            }
          },
          *client(_handoff, _ctx, _params) {
            return { selectedIndex: 0 }
          },
          *after(handoff, client) {
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

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      const phase1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', { difficulty: 'hard' }, signal)
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
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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

      const tool = createIsomorphicTool('post_handoff')
        .description('Tool with code after handoff')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .handoff({
          *before() {
            return { x: 1 }
          },
          *client(_handoff, _ctx, _params) {
            return { y: 2 }
          },
          *after(handoff, client) {
            // Post-process happens here
            afterHandoffFn({ x: handoff.x, y: client.y })
            return { x: handoff.x, y: client.y, postProcessed: true }
          },
        })

      const anyTool = tool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1 - afterHandoffFn should NOT run (it's in after())
      await run(function* () {
        return yield* executeServerPart(anyTool, 'call-1', {}, signal)
      })
      expect(afterHandoffFn).not.toHaveBeenCalled()

      // Phase 2 - afterHandoffFn SHOULD run
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
      const anyTool = guessTheCardTool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1: Pick the secret card and generate choices
      const phase1 = await run(function* () {
        return yield* executeServerPart(
          anyTool,
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
      const correctResult = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
      const anyTool = guessTheCardTool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Phase 1
      const phase1 = await run(function* () {
        return yield* executeServerPart(
          anyTool,
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
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
      const anyTool = guessTheCardTool as unknown as AnyIsomorphicTool
      const signal = new AbortController().signal

      // Run phase 1 twice - should get different secrets each time
      // (proving phase 1 actually picks)
      const run1 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-a', {}, signal)
      })

      const run2 = await run(function* () {
        return yield* executeServerPart(anyTool, 'call-b', {}, signal)
      })

      // These MIGHT be the same (52 cards), but the point is they're independent
      // The key test is that phase 2 uses cached data, not a new pick

      const secret1 = (run1.serverOutput as { secret: string }).secret
      const secret2 = (run2.serverOutput as { secret: string }).secret

      // Now run phase 2 for run1 with the wrong secret from run2
      // It should validate against run1's secret, not a new pick
      const result = await run(function* () {
        return yield* executeServerPhase2(
          anyTool,
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
