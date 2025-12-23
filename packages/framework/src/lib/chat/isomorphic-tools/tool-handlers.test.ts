/**
 * Tool Handlers API Tests
 *
 * Tests for the type-safe tool handler API that provides:
 * 1. Full type inference from tool definitions
 * 2. Declarative React integration via useChatSession
 * 3. Elimination of the callback singleton pattern
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import { z } from 'zod'
import { createIsomorphicTool } from './builder'
import type { InferToolHandoff, InferToolClientOutput, InferToolParams } from './builder'
import {
  handler,
  createHandlerRegistry,
  createToolHandlers,
  isHandoffFor,
  type PendingHandoff,
} from './tool-handlers'

// =============================================================================
// TEST TOOLS
// =============================================================================

const guessTheCardTool = createIsomorphicTool('guess_the_card')
  .description('Pick a card and let the user guess')
  .parameters(z.object({
    prompt: z.string().optional(),
    numChoices: z.number().min(2).max(10).optional(),
  }))
  .authority('server')
  .handoff({
    *before(params) {
      const secret = 'Ace of Spades'
      const choices = ['Ace of Spades', 'King of Hearts', 'Queen of Diamonds', '7 of Clubs']
      return {
        secret,
        secretColor: 'black' as const,
        choices,
        hint: 'I picked a black card...',
        prompt: params.prompt ?? 'Which card am I thinking of?',
      }
    },
    *client(handoff, _ctx, _params) {
      return { guess: handoff.choices[0] }
    },
    *after(handoff, client) {
      return {
        correct: client.guess === handoff.secret,
        secret: handoff.secret,
        guess: client.guess,
      }
    },
  })

const askYesNoTool = createIsomorphicTool('ask_yes_no')
  .description('Ask the user a yes/no question')
  .parameters(z.object({
    question: z.string(),
    context: z.string().optional(),
  }))
  .authority('client')
  .client(function* (params, _ctx) {
    return { answer: true, question: params.question }
  })
  .server(function* (_params, _ctx, clientOutput) {
    return {
      question: clientOutput.question,
      answer: clientOutput.answer,
      response: clientOutput.answer ? 'User said YES' : 'User said NO',
    }
  })

const giveHintTool = createIsomorphicTool('give_hint')
  .description('Give the user a hint')
  .parameters(z.object({
    hint: z.string(),
    style: z.enum(['mystical', 'playful', 'dramatic']).default('mystical'),
  }))
  .authority('server')
  .server(function* (params, _ctx) {
    return {
      hint: params.hint,
      style: params.style,
      timestamp: Date.now(),
    }
  })
  .client(function* (serverOutput, _ctx, _params) {
    console.log(`Hint: ${serverOutput.hint}`)
    return { displayed: true }
  })

const testTools = [guessTheCardTool, askYesNoTool, giveHintTool] as const

// Verify testTools is usable
void testTools

// =============================================================================
// TYPE EXTRACTION TESTS
// =============================================================================

describe('Type Extraction from Tools', () => {
  it('should extract handoff type from V7 handoff tool', () => {
    type GuessCardHandoff = InferToolHandoff<typeof guessTheCardTool>

    expectTypeOf<GuessCardHandoff>().toEqualTypeOf<{
      secret: string
      secretColor: 'black'
      choices: string[]
      hint: string
      prompt: string
    }>()
  })

  it('should extract client output type', () => {
    type GuessCardClientOutput = InferToolClientOutput<typeof guessTheCardTool>
    expectTypeOf<GuessCardClientOutput>().toEqualTypeOf<{ guess: string }>()
  })

  it('should extract params type', () => {
    type GuessCardParams = InferToolParams<typeof guessTheCardTool>
    expectTypeOf<GuessCardParams>().toEqualTypeOf<{
      prompt?: string | undefined
      numChoices?: number | undefined
    }>()
  })
})

// =============================================================================
// PER-TOOL HANDLER REGISTRATION
// =============================================================================

describe('Per-Tool Handler Registration', () => {
  it('should provide full type inference via handler() helper', () => {
    const guessCardHandler = handler(guessTheCardTool, (data, respond) => {
      // Full type inference!
      expectTypeOf(data).toEqualTypeOf<{
        secret: string
        secretColor: 'black'
        choices: string[]
        hint: string
        prompt: string
      }>()

      expectTypeOf(respond).toEqualTypeOf<(output: { guess: string }) => void>()

      // Use the data
      const choices = data.choices
      void choices
      respond({ guess: 'Ace' })

      return null
    })

    expect(guessCardHandler.tool.name).toBe('guess_the_card')
  })

  it('should infer params for client-authority tools', () => {
    const askHandler = handler(askYesNoTool, (data, respond) => {
      expectTypeOf(data).toEqualTypeOf<{
        question: string
        context?: string | undefined
      }>()

      expectTypeOf(respond).toEqualTypeOf<(output: { answer: boolean; question: string }) => void>()

      respond({ answer: true, question: data.question })

      return null
    })

    expect(askHandler.tool.name).toBe('ask_yes_no')
  })

  it('should infer serverOutput for simple server-authority tools', () => {
    const hintHandler = handler(giveHintTool, (data, respond) => {
      expectTypeOf(data).toEqualTypeOf<{
        hint: string
        style: 'mystical' | 'playful' | 'dramatic'
        timestamp: number
      }>()

      expectTypeOf(respond).toEqualTypeOf<(output: { displayed: boolean }) => void>()

      return null
    })

    expect(hintHandler.tool.name).toBe('give_hint')
  })
})

// =============================================================================
// HANDLER REGISTRY
// =============================================================================

describe('createHandlerRegistry', () => {
  it('should create a registry from typed handlers', () => {
    const registry = createHandlerRegistry([
      handler(guessTheCardTool, (data, respond) => {
        respond({ guess: data.choices[0] })
        return null
      }),
      handler(askYesNoTool, (data, respond) => {
        respond({ answer: true, question: data.question })
        return null
      }),
    ])

    expect(registry.has('guess_the_card')).toBe(true)
    expect(registry.has('ask_yes_no')).toBe(true)
    expect(registry.has('give_hint')).toBe(false)
    expect(registry.handledTools()).toEqual(['guess_the_card', 'ask_yes_no'])
  })

  it('should render pending handoffs', () => {
    const rendered: string[] = []

    const registry = createHandlerRegistry([
      handler(guessTheCardTool, (data) => {
        rendered.push(`card:${data.choices.length}`)
        // Return a string as a valid ReactNode (not null)
        return `card-ui-${data.choices.length}`
      }),
    ])

    const handoffs: PendingHandoff[] = [
      {
        callId: '1',
        toolName: 'guess_the_card',
        params: {},
        data: {
          secret: 'Ace',
          secretColor: 'black',
          choices: ['Ace', 'King', 'Queen'],
          hint: '',
          prompt: '',
        },
        authority: 'server',
        usesHandoff: true,
      },
      {
        callId: '2',
        toolName: 'unknown_tool', // No handler
        params: {},
        data: {},
        authority: 'server',
        usesHandoff: false,
      },
    ]

    const nodes = registry.render(handoffs, vi.fn())

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toBe('card-ui-3')
    expect(rendered).toEqual(['card:3'])
  })

  it('should call respond with correct callId', () => {
    let capturedRespond: ((output: { guess: string }) => void) | null = null

    const registry = createHandlerRegistry([
      handler(guessTheCardTool, (_data, respond) => {
        capturedRespond = respond
        return null
      }),
    ])

    const respondMock = vi.fn()

    registry.renderOne(
      {
        callId: 'call-xyz',
        toolName: 'guess_the_card',
        params: {},
        data: { secret: '', secretColor: 'black', choices: [], hint: '', prompt: '' },
        authority: 'server',
        usesHandoff: true,
      },
      respondMock
    )

    capturedRespond!({ guess: 'Ace' })

    expect(respondMock).toHaveBeenCalledWith('call-xyz', { guess: 'Ace' })
  })

  it('should throw on duplicate handlers', () => {
    expect(() => {
      createHandlerRegistry([
        handler(guessTheCardTool, () => null),
        handler(guessTheCardTool, () => null),
      ])
    }).toThrow('Duplicate handler for tool: "guess_the_card"')
  })
})

// =============================================================================
// BUILDER PATTERN
// =============================================================================

describe('Builder Pattern', () => {
  it('should allow fluent handler registration', () => {
    const registry = createToolHandlers()
      .add(guessTheCardTool, (data, respond) => {
        // Full type inference in each .add() call
        const choices: string[] = data.choices
        void choices
        respond({ guess: 'Ace' })
        return null
      })
      .add(askYesNoTool, (data, respond) => {
        const question: string = data.question
        void question
        respond({ answer: true, question: 'test' })
        return null
      })
      .build()

    expect(registry.handledTools()).toEqual(['guess_the_card', 'ask_yes_no'])
  })
})

// =============================================================================
// INTEGRATION WITH useChatSession
// =============================================================================

interface UseChatSessionReturn {
  state: { messages: unknown[]; isStreaming: boolean }
  send: (content: string) => void
  abort: () => void
  reset: () => void
  pendingHandoffs: PendingHandoff[]
  respondToHandoff: (callId: string, output: unknown) => void
}

function mockUseChatSession(): UseChatSessionReturn {
  return {
    state: { messages: [], isStreaming: false },
    send: () => {},
    abort: () => {},
    reset: () => {},
    pendingHandoffs: [],
    respondToHandoff: () => {},
  }
}

describe('Integration with useChatSession', () => {
  it('demonstrates complete usage pattern', () => {
    // 1. Create typed handler registry
    const toolHandlers = createToolHandlers()
      .add(guessTheCardTool, (data, respond) => {
        // In real code: return <CardPicker choices={data.choices} onPick={...} />
        console.log('Showing choices:', data.choices)
        respond({ guess: data.choices[0] })
        return null
      })
      .add(askYesNoTool, (data, respond) => {
        // In real code: return <YesNoDialog question={data.question} onAnswer={...} />
        console.log('Asking:', data.question)
        respond({ answer: true, question: data.question })
        return null
      })
      .build()

    // 2. Use in component with useChatSession
    const session = mockUseChatSession()

    // 3. Render pending handoffs
    const nodes = toolHandlers.render(
      session.pendingHandoffs,
      session.respondToHandoff
    )

    expect(nodes).toEqual([])

    expect(toolHandlers.handledTools()).toEqual(['guess_the_card', 'ask_yes_no'])
  })
})

// =============================================================================
// TYPE-SAFE MANUAL RENDERING
// =============================================================================

describe('Type-Safe Manual Rendering', () => {
  it('should allow type narrowing with isHandoffFor', () => {
    const handoff: PendingHandoff = {
      callId: '1',
      toolName: 'guess_the_card',
      params: {},
      data: {
        secret: 'Ace',
        secretColor: 'black',
        choices: ['Ace', 'King'],
        hint: 'Black card',
        prompt: 'Pick!',
      },
      authority: 'server',
      usesHandoff: true,
    }

    if (isHandoffFor(handoff, guessTheCardTool)) {
      // Type narrowed!
      const choices: string[] = handoff.data.choices
      const secret: string = handoff.data.secret
      void choices
      void secret
    }

    if (isHandoffFor(handoff, askYesNoTool)) {
      // Different type
      const question: string = handoff.data.question
      void question
    }

    expect(handoff).toBeDefined()
  })
})

// =============================================================================
// API SUMMARY
// =============================================================================

describe('API Summary', () => {
  it('validates the final design works', () => {
    const toolHandlers = createToolHandlers()
      .add(guessTheCardTool, (data, respond) => {
        respond({ guess: data.choices[0] })
        return null
      })
      .build()

    expect(toolHandlers.has('guess_the_card')).toBe(true)
  })
})
