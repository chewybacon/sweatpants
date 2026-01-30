/**
 * Sampling with Structured Output & Tools Tests
 *
 * Tests for ctx.sample() with:
 * - schema: Zod schema for structured output
 * - tools: Tool definitions for LLM-driven decisions
 *
 * These tests validate Phase 5 of the sampling-tools implementation.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, each, sleep } from 'effection'
import { z } from 'zod'
import {
  createMcpTool,
  createBridgeHost,
} from '../index'
import type {
  BridgeSampleOptions,
  BridgeSamplingProvider,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolCall,
} from '../index'

// =============================================================================
// MOCK SAMPLING PROVIDER
// =============================================================================

interface MockSampleResponse {
  text?: string
  toolCalls?: SamplingToolCall[]
  stopReason?: 'endTurn' | 'toolUse'
}

/**
 * Create a mock sampling provider that returns predetermined responses.
 * Tracks calls for assertions.
 */
function createMockSamplingProvider(
  responses: MockSampleResponse[]
): BridgeSamplingProvider & { calls: Array<{ messages: unknown[]; options?: BridgeSampleOptions }> } {
  let callIndex = 0
  const calls: Array<{ messages: unknown[]; options?: BridgeSampleOptions }> = []

  return {
    calls,
    sample(_messages, options) {
      return {
        *[Symbol.iterator]() {
          // Handle exactOptionalPropertyTypes by only including options if defined
          if (options !== undefined) {
            calls.push({ messages: _messages, options })
          } else {
            calls.push({ messages: _messages })
          }
          const response = responses[callIndex++] ?? { text: `Response ${callIndex}` }

          // Return appropriate result type based on response
          if (response.stopReason === 'toolUse' && response.toolCalls) {
            return {
              text: response.text ?? '',
              stopReason: 'toolUse',
              toolCalls: response.toolCalls,
            } as SampleResultWithToolCalls
          }

          return { text: response.text ?? '' } as SampleResultBase
        },
      }
    },
  }
}

// =============================================================================
// STRUCTURED OUTPUT TESTS (schema)
// =============================================================================

describe('ctx.sample() with schema', () => {
  it('should pass schema to sampling provider options', async () => {
    const MoveSchema = z.object({ cell: z.number().min(0).max(8) })

    const tool = createMcpTool('schema_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const result = yield* ctx.sample({
          prompt: 'Pick a cell',
          schema: MoveSchema,
        })
        return { result }
      })

    const provider = createMockSamplingProvider([{ text: '{"cell": 4}' }])

    await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            // Verify schema was passed in options
            expect(event.options?.schema).toBeDefined()
            expect(event.options?.schema).toHaveProperty('type', 'object')
            expect(event.options?.schema).toHaveProperty('properties')

            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      yield* host.run()
    })

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.options?.schema).toBeDefined()
  })

  it('should return parsed object for valid JSON response', async () => {
    const MoveSchema = z.object({ cell: z.number() })

    const tool = createMcpTool('parse_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const result = yield* ctx.sample({
          prompt: 'Pick a cell',
          schema: MoveSchema,
        })
        // With schema, result should have parsed field
        return {
          text: result.text,
          parsed: (result as SampleResultWithParsed<{ cell: number }>).parsed,
          parseError: (result as SampleResultWithParsed<{ cell: number }>).parseError,
        }
      })

    const provider = createMockSamplingProvider([{ text: '{"cell": 4}' }])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(result.text).toBe('{"cell": 4}')
    expect(result.parsed).toEqual({ cell: 4 })
    expect(result.parseError).toBeUndefined()
  })

  it('should return parseError for invalid JSON response', async () => {
    const MoveSchema = z.object({ cell: z.number() })

    const tool = createMcpTool('invalid_json_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const result = yield* ctx.sample({
          prompt: 'Pick a cell',
          schema: MoveSchema,
        })
        return {
          text: result.text,
          parsed: (result as SampleResultWithParsed<{ cell: number }>).parsed,
          parseError: (result as SampleResultWithParsed<{ cell: number }>).parseError,
        }
      })

    const provider = createMockSamplingProvider([{ text: 'I choose cell 4' }])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(result.text).toBe('I choose cell 4')
    expect(result.parsed).toBeNull()
    expect(result.parseError).toBeDefined()
    expect(result.parseError?.rawText).toBe('I choose cell 4')
  })

  it('should return parseError for schema validation failure', async () => {
    const MoveSchema = z.object({ cell: z.number().min(0).max(8) })

    const tool = createMcpTool('schema_mismatch_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const result = yield* ctx.sample({
          prompt: 'Pick a cell',
          schema: MoveSchema,
        })
        return {
          text: result.text,
          parsed: (result as SampleResultWithParsed<{ cell: number }>).parsed,
          parseError: (result as SampleResultWithParsed<{ cell: number }>).parseError,
        }
      })

    // Valid JSON but invalid schema (cell is string, not number)
    const provider = createMockSamplingProvider([{ text: '{"cell": "four"}' }])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(result.text).toBe('{"cell": "four"}')
    expect(result.parsed).toBeNull()
    expect(result.parseError).toBeDefined()
    expect(result.parseError?.message).toContain('expected number')
  })

  it('should support retry loop pattern', async () => {
    const MoveSchema = z.object({ cell: z.number() })
    let attempts = 0

    const tool = createMcpTool('retry_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const MAX_RETRIES = 3

        for (let i = 0; i < MAX_RETRIES; i++) {
          attempts++
          const result = yield* ctx.sample({
            prompt: i === 0 ? 'Pick a cell' : 'Invalid response. Pick a cell (0-8)',
            schema: MoveSchema,
          })

          const parsed = (result as SampleResultWithParsed<{ cell: number }>).parsed
          if (parsed !== null) {
            return { cell: parsed.cell, attempts }
          }
        }

        return { error: 'Max retries exceeded', attempts }
      })

    // First response invalid, second valid
    const provider = createMockSamplingProvider([
      { text: 'I pick the center' },
      { text: '{"cell": 4}' },
    ])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(result.cell).toBe(4)
    expect(result.attempts).toBe(2)
    expect(provider.calls).toHaveLength(2)
  })
})

// =============================================================================
// TOOL CALLING TESTS (tools)
// =============================================================================

describe('ctx.sample() with tools', () => {
  it('should pass tools and toolChoice to provider', async () => {
    const tool = createMcpTool('tools_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const result = yield* ctx.sample({
          prompt: 'Choose a strategy',
          tools: [
            {
              name: 'play_offensive',
              description: 'Go for the win',
              inputSchema: z.object({ reasoning: z.string() }),
            },
            {
              name: 'play_defensive',
              description: 'Block threats',
              inputSchema: z.object({ threat: z.string() }),
            },
          ],
          toolChoice: 'required',
        })
        return { result }
      })

    const provider = createMockSamplingProvider([
      {
        text: '',
        stopReason: 'toolUse',
        toolCalls: [{ id: 'call_1', name: 'play_offensive', arguments: { reasoning: 'Going for win' } }],
      },
    ])

    await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            // Verify tools were passed
            expect(event.options?.tools).toBeDefined()
            expect(event.options?.tools).toHaveLength(2)
            expect(event.options?.tools?.[0]?.name).toBe('play_offensive')
            expect(event.options?.toolChoice).toBe('required')

            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      yield* host.run()
    })

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.options?.tools).toHaveLength(2)
    expect(provider.calls[0]?.options?.toolChoice).toBe('required')
  })

  it('should return toolCalls when stopReason is toolUse', async () => {
    const tool = createMcpTool('tool_calls_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        const result = yield* ctx.sample({
          prompt: 'Choose a strategy',
          tools: [
            {
              name: 'play_offensive',
              inputSchema: z.object({ reasoning: z.string() }),
            },
          ],
          toolChoice: 'required',
        })

        // With tools, result should have toolCalls
        const toolResult = result as SampleResultWithToolCalls
        return {
          stopReason: toolResult.stopReason,
          toolCalls: toolResult.toolCalls,
        }
      })

    const provider = createMockSamplingProvider([
      {
        text: '',
        stopReason: 'toolUse',
        toolCalls: [{ id: 'call_123', name: 'play_offensive', arguments: { reasoning: 'Win!' } }],
      },
    ])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(result.stopReason).toBe('toolUse')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toEqual({
      id: 'call_123',
      name: 'play_offensive',
      arguments: { reasoning: 'Win!' },
    })
  })

  it('should support multi-turn with tool results', async () => {
    const tool = createMcpTool('multi_turn_test')
      .description('Test tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, ctx) {
        // L1: Strategy decision
        const strategy = yield* ctx.sample({
          prompt: 'Choose a strategy',
          tools: [
            { name: 'play_offensive', inputSchema: z.object({ reasoning: z.string() }) },
            { name: 'play_defensive', inputSchema: z.object({ threat: z.string() }) },
          ],
          toolChoice: 'required',
        })

        const strategyResult = strategy as SampleResultWithToolCalls
        const strategyCall = strategyResult.toolCalls[0]!

        // L2: Move with tool result context
        // Note: Using 'as any' because Message type doesn't include tool_calls/tool role
        // The actual sampling provider handles these extended message types
        const move = yield* ctx.sample({
          messages: [
            { role: 'user', content: 'Current board: empty' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: strategyCall.id,
                type: 'function',
                function: { name: strategyCall.name, arguments: strategyCall.arguments },
              }],
            },
            {
              role: 'tool',
              content: `Playing ${strategyCall.name}. Pick a cell.`,
              tool_call_id: strategyCall.id,
            },
          ] as any,
          schema: z.object({ cell: z.number() }),
        })

        const moveResult = move as SampleResultWithParsed<{ cell: number }>
        return {
          strategy: strategyCall.name,
          cell: moveResult.parsed?.cell,
        }
      })

    let sampleCallCount = 0
    const provider = createMockSamplingProvider([
      // L1 response
      {
        text: '',
        stopReason: 'toolUse',
        toolCalls: [{ id: 'call_1', name: 'play_offensive', arguments: { reasoning: 'Go for win' } }],
      },
      // L2 response
      { text: '{"cell": 4}' },
    ])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: {} })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            sampleCallCount++
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(sampleCallCount).toBe(2)
    expect(result.strategy).toBe('play_offensive')
    expect(result.cell).toBe(4)

    // Verify L2 had tool context in messages
    const l2Call = provider.calls[1]
    expect(l2Call?.messages).toHaveLength(3)
    expect((l2Call?.messages[1] as { tool_calls?: unknown[] })?.tool_calls).toBeDefined()
    expect((l2Call?.messages[2] as { role: string })?.role).toBe('tool')
  })
})

// =============================================================================
// DECISION TREE PATTERN TEST (Full Integration)
// =============================================================================

describe('Decision tree pattern (L1 tools -> L2 schema)', () => {
  it('should implement 2-level decision tree for game AI', async () => {
    // This test validates the full pattern used in play_ttt
    const tool = createMcpTool('decision_tree')
      .description('Decision tree test')
      .parameters(z.object({ board: z.string() }))
      .elicits({})
      .execute(function* (params, ctx) {
        const MoveSchema = z.object({ cell: z.number().min(0).max(8) })

        // Level 1: Strategy (tools)
        const strategy = yield* ctx.sample({
          prompt: `Board: ${params.board}\nChoose strategy.`,
          tools: [
            { name: 'offensive', inputSchema: z.object({ target: z.string() }) },
            { name: 'defensive', inputSchema: z.object({ block: z.string() }) },
          ],
          toolChoice: 'required',
        })

        const strategyResult = strategy as SampleResultWithToolCalls
        const chosen = strategyResult.toolCalls[0]!

        // Level 2: Move (schema)
        // Note: Using 'as any' because Message type doesn't include tool_calls/tool role
        const move = yield* ctx.sample({
          messages: [
            { role: 'user', content: `Board: ${params.board}` },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: chosen.id,
                type: 'function',
                function: { name: chosen.name, arguments: chosen.arguments },
              }],
            },
            {
              role: 'tool',
              content: `Strategy: ${chosen.name}. Pick cell.`,
              tool_call_id: chosen.id,
            },
          ] as any,
          schema: MoveSchema,
        })

        const moveResult = move as SampleResultWithParsed<{ cell: number }>

        return {
          strategy: chosen.name,
          strategyArgs: chosen.arguments,
          cell: moveResult.parsed?.cell ?? -1,
          parseError: moveResult.parseError,
        }
      })

    const provider = createMockSamplingProvider([
      // L1: Choose offensive
      {
        stopReason: 'toolUse',
        toolCalls: [{ id: 'tc_1', name: 'offensive', arguments: { target: 'center' } }],
      },
      // L2: Pick cell 4
      { text: '{"cell": 4}' },
    ])

    const result = await run(function* () {
      const host = createBridgeHost({ tool, params: { board: '_________' } })

      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          if (event.type === 'sample') {
            const sampleResult = yield* provider.sample(event.messages, event.options)
            event.responseSignal.send({ result: sampleResult })
          }
          yield* each.next()
        }
      })

      yield* sleep(0)
      return yield* host.run()
    })

    expect(result.strategy).toBe('offensive')
    expect(result.strategyArgs).toEqual({ target: 'center' })
    expect(result.cell).toBe(4)
    expect(result.parseError).toBeUndefined()
  })
})
