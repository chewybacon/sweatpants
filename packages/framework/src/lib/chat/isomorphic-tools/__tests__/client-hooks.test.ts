/**
 * Tests for Type-Safe Client Hooks
 *
 * These tests verify that the client hooks correctly extract and apply types
 * from the builder pattern.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import { z } from 'zod'
import { createElement } from 'react'
import { createIsomorphicTool } from '../builder.ts'
import {
  createHandoffHandler,
  createHandoffRegistry,
  createTypedPendingHandoff,
  narrowHandoff,
  type ExtractHandoff,
  type ExtractClientOutput,
  type ExtractParams,
} from '../client-hooks.ts'
import type { IsomorphicHandoffEvent } from '../types.ts'

// =============================================================================
// Test Tools
// =============================================================================

const guessCardTool = createIsomorphicTool('guess_card')
  .description('Guess a card')
  .parameters(z.object({ 
    prompt: z.string(),
    difficulty: z.enum(['easy', 'hard']).optional(),
  }))
  .context('headless')
  .authority('server')
  .handoff({
    *before(params) {
      return { 
        secret: 'Ace of Spades', 
        choices: ['Ace of Spades', 'King of Hearts', 'Queen of Diamonds'],
        hint: params.prompt,
      }
    },
    *client(handoff, _ctx, _params) {
      return { guess: handoff.choices[0] }
    },
    *after(handoff, client) {
      return { 
        correct: client.guess === handoff.secret,
        secret: handoff.secret,
      }
    },
  })

const pickNumberTool = createIsomorphicTool('pick_number')
  .description('Pick a number')
  .parameters(z.object({ max: z.number() }))
  .context('headless')
  .authority('server')
  .handoff({
    *before(params) {
      return { 
        target: Math.floor(Math.random() * params.max),
        range: { min: 0, max: params.max },
      }
    },
    *client(handoff) {
      return { picked: handoff.range.max / 2 }
    },
    *after(handoff, client) {
      return { 
        hit: client.picked === handoff.target,
        target: handoff.target,
      }
    },
  })

// =============================================================================
// Type Extraction Tests
// =============================================================================

describe('Type Extraction', () => {
  it('should extract handoff type from tool', () => {
    type CardHandoff = ExtractHandoff<typeof guessCardTool>
    
    expectTypeOf<CardHandoff>().toEqualTypeOf<{
      secret: string
      choices: string[]
      hint: string
    }>()
  })

  it('should extract client output type from tool', () => {
    type CardClientOutput = ExtractClientOutput<typeof guessCardTool>
    
    expectTypeOf<CardClientOutput>().toEqualTypeOf<{ guess: string }>()
  })

  it('should extract params type from tool', () => {
    type CardParams = ExtractParams<typeof guessCardTool>
    
    expectTypeOf<CardParams>().toEqualTypeOf<{
      prompt: string
      difficulty?: 'easy' | 'hard' | undefined
    }>()
  })
})

// =============================================================================
// createHandoffHandler Tests
// =============================================================================

describe('createHandoffHandler', () => {
  it('should create a handler with correct types', () => {
    const handler = createHandoffHandler(guessCardTool, (handoff, params, respond) => {
      // Type assertions
      expectTypeOf(handoff.secret).toBeString()
      expectTypeOf(handoff.choices).toEqualTypeOf<string[]>()
      expectTypeOf(params.prompt).toBeString()
      expectTypeOf(respond).toBeFunction()
      
      return createElement('div', null, handoff.secret)
    })
    
    expect(handler.toolName).toBe('guess_card')
  })

  it('should return null for non-matching tool', () => {
    const handler = createHandoffHandler(guessCardTool, () => createElement('div'))
    
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'other_tool',
      params: {},
      serverOutput: {},
      authority: 'server',
    }
    
    const result = handler(event, vi.fn())
    expect(result).toBeNull()
  })

  it('should call handler for matching tool', () => {
    const handlerFn = vi.fn(() => createElement('div'))
    const handler = createHandoffHandler(guessCardTool, handlerFn)
    
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'guess_card',
      params: { prompt: 'Pick a card!' },
      serverOutput: { secret: 'Ace', choices: ['Ace', 'King'], hint: 'Pick a card!' },
      authority: 'server',
    }
    
    const respond = vi.fn()
    handler(event, respond)
    
    expect(handlerFn).toHaveBeenCalledWith(
      { secret: 'Ace', choices: ['Ace', 'King'], hint: 'Pick a card!' },
      { prompt: 'Pick a card!' },
      respond,
      event
    )
  })

  it('should pass respond function that can be called with client output', () => {
    let capturedRespond: ((output: { guess: string }) => void) | undefined
    
    const handler = createHandoffHandler(guessCardTool, (_handoff, _params, respond) => {
      capturedRespond = respond
      return createElement('div')
    })
    
    const respondMock = vi.fn()
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'guess_card',
      params: { prompt: 'test' },
      serverOutput: { secret: 'Ace', choices: ['Ace'], hint: 'test' },
      authority: 'server',
    }
    
    handler(event, respondMock)
    
    expect(capturedRespond).toBeDefined()
    capturedRespond!({ guess: 'King' })
    expect(respondMock).toHaveBeenCalledWith({ guess: 'King' })
  })
})

// =============================================================================
// createHandoffRegistry Tests
// =============================================================================

describe('createHandoffRegistry', () => {
  it('should dispatch to correct handler', () => {
    const cardHandler = vi.fn(() => createElement('div', null, 'card'))
    const numberHandler = vi.fn(() => createElement('div', null, 'number'))
    
    const registry = createHandoffRegistry([
      createHandoffHandler(guessCardTool, cardHandler),
      createHandoffHandler(pickNumberTool, numberHandler),
    ])
    
    const cardEvent: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'guess_card',
      params: { prompt: 'test' },
      serverOutput: { secret: 'Ace', choices: [], hint: '' },
      authority: 'server',
    }
    
    registry.handle(cardEvent, vi.fn())
    
    expect(cardHandler).toHaveBeenCalled()
    expect(numberHandler).not.toHaveBeenCalled()
  })

  it('should return null for unknown tool', () => {
    const registry = createHandoffRegistry([
      createHandoffHandler(guessCardTool, () => createElement('div')),
    ])
    
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'unknown_tool',
      params: {},
      serverOutput: {},
      authority: 'server',
    }
    
    const result = registry.handle(event, vi.fn())
    expect(result).toBeNull()
  })

  it('should throw on duplicate handlers', () => {
    expect(() => {
      createHandoffRegistry([
        createHandoffHandler(guessCardTool, () => createElement('div')),
        createHandoffHandler(guessCardTool, () => createElement('span')),
      ])
    }).toThrow('Duplicate handoff handler')
  })

  it('should check if handler exists', () => {
    const registry = createHandoffRegistry([
      createHandoffHandler(guessCardTool, () => createElement('div')),
    ])
    
    expect(registry.has('guess_card')).toBe(true)
    expect(registry.has('pick_number')).toBe(false)
  })
})

// =============================================================================
// createTypedPendingHandoff Tests
// =============================================================================

describe('createTypedPendingHandoff', () => {
  it('should create typed pending handoff for matching tool', () => {
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'guess_card',
      params: { prompt: 'Pick!' },
      serverOutput: { secret: 'Ace', choices: ['Ace', 'King'], hint: 'Pick!' },
      authority: 'server',
    }
    
    const respond = vi.fn()
    const pending = createTypedPendingHandoff(guessCardTool, event, respond)
    
    expect(pending).not.toBeNull()
    expect(pending!.toolName).toBe('guess_card')
    expect(pending!.callId).toBe('call-1')
    expect(pending!.handoff.secret).toBe('Ace')
    expect(pending!.params.prompt).toBe('Pick!')
    
    // Type check
    expectTypeOf(pending!.handoff).toEqualTypeOf<{
      secret: string
      choices: string[]
      hint: string
    }>()
    
    // Respond should work
    pending!.respond({ guess: 'King' })
    expect(respond).toHaveBeenCalledWith({ guess: 'King' })
  })

  it('should return null for non-matching tool', () => {
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'other_tool',
      params: {},
      serverOutput: {},
      authority: 'server',
    }
    
    const pending = createTypedPendingHandoff(guessCardTool, event, vi.fn())
    expect(pending).toBeNull()
  })
})

// =============================================================================
// narrowHandoff Tests
// =============================================================================

describe('narrowHandoff', () => {
  it('should narrow types for matching tool', () => {
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'guess_card',
      params: { prompt: 'test' },
      serverOutput: { secret: 'Ace', choices: ['Ace'], hint: 'test' },
      authority: 'server',
    }
    
    const respond = vi.fn()
    const narrowed = narrowHandoff(guessCardTool, event, respond)
    
    expect(narrowed).not.toBeNull()
    
    // Type checks
    expectTypeOf(narrowed!.handoff.secret).toBeString()
    expectTypeOf(narrowed!.params.prompt).toBeString()
    
    narrowed!.respond({ guess: 'Queen' })
    expect(respond).toHaveBeenCalledWith({ guess: 'Queen' })
  })

  it('should return null for non-matching tool', () => {
    const event: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-1',
      toolName: 'other_tool',
      params: {},
      serverOutput: {},
      authority: 'server',
    }
    
    const narrowed = narrowHandoff(guessCardTool, event, vi.fn())
    expect(narrowed).toBeNull()
  })
})
