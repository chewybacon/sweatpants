/**
 * MCP Spec Alignment Tests
 *
 * Tests for the MCP 2025-11-25 spec alignment changes:
 * 1. __schema__ meta-tool encoding pattern
 * 2. SampleExchange message counts (2 for raw, 3 for structured)
 * 3. URL elicitation guard
 * 4. createRawSampleExchange / createStructuredSampleExchange helpers
 */
import { describe, it, expect } from 'vitest'
import {
  encodeSamplingRequest,
  encodeElicitationRequest,
  SCHEMA_TOOL_NAME,
} from '../protocol/message-encoder.ts'
import {
  createRawSampleExchange,
  createStructuredSampleExchange,
} from '../mcp-tool-types.ts'
import type {
  SampleRequestEvent,
  ElicitRequestEvent,
} from '../session/types.ts'

// =============================================================================
// __SCHEMA__ META-TOOL ENCODING
// =============================================================================

describe('__schema__ meta-tool encoding', () => {
  it('should transform schema into __schema__ tool', () => {
    const event: SampleRequestEvent = {
      type: 'sample_request',
      lsn: 1,
      timestamp: Date.now(),
      sampleId: 'sample_1',
      messages: [{ role: 'user', content: 'Pick a cell' }],
      schema: {
        type: 'object',
        properties: {
          cell: { type: 'number', minimum: 0, maximum: 8 },
        },
        required: ['cell'],
      },
    }

    const request = encodeSamplingRequest(event, 'req_1')

    // Should have tools array with __schema__ first
    expect(request.params?.tools).toBeDefined()
    expect(request.params?.tools).toHaveLength(1)
    expect(request.params?.tools?.[0]?.name).toBe(SCHEMA_TOOL_NAME)
    expect(request.params?.tools?.[0]?.description).toBe(
      'Respond with structured data matching this schema.'
    )
    expect(request.params?.tools?.[0]?.inputSchema).toEqual(event.schema)

    // Should force tool choice to required
    expect(request.params?.toolChoice).toEqual({ mode: 'required' })
  })

  it('should prepend __schema__ to existing tools', () => {
    const event: SampleRequestEvent = {
      type: 'sample_request',
      lsn: 1,
      timestamp: Date.now(),
      sampleId: 'sample_1',
      messages: [{ role: 'user', content: 'Pick a strategy' }],
      schema: { type: 'object', properties: { choice: { type: 'string' } } },
      tools: [
        { name: 'offensive', inputSchema: { type: 'object' } },
        { name: 'defensive', inputSchema: { type: 'object' } },
      ],
    }

    const request = encodeSamplingRequest(event, 'req_1')

    // Should have __schema__ first, then existing tools
    expect(request.params?.tools).toHaveLength(3)
    expect(request.params?.tools?.[0]?.name).toBe(SCHEMA_TOOL_NAME)
    expect(request.params?.tools?.[1]?.name).toBe('offensive')
    expect(request.params?.tools?.[2]?.name).toBe('defensive')
  })

  it('should not add __schema__ when no schema provided', () => {
    const event: SampleRequestEvent = {
      type: 'sample_request',
      lsn: 1,
      timestamp: Date.now(),
      sampleId: 'sample_1',
      messages: [{ role: 'user', content: 'Hello' }],
    }

    const request = encodeSamplingRequest(event, 'req_1')

    expect(request.params?.tools).toBeUndefined()
    expect(request.params?.toolChoice).toBeUndefined()
  })

  it('should pass through tools without schema', () => {
    const event: SampleRequestEvent = {
      type: 'sample_request',
      lsn: 1,
      timestamp: Date.now(),
      sampleId: 'sample_1',
      messages: [{ role: 'user', content: 'Pick' }],
      tools: [{ name: 'pick', inputSchema: { type: 'object' } }],
      toolChoice: 'auto',
    }

    const request = encodeSamplingRequest(event, 'req_1')

    expect(request.params?.tools).toHaveLength(1)
    expect(request.params?.tools?.[0]?.name).toBe('pick')
    expect(request.params?.toolChoice).toEqual({ mode: 'auto' })
  })
})

// =============================================================================
// SAMPLE EXCHANGE HELPERS
// =============================================================================

describe('SampleExchange helpers', () => {
  describe('createRawSampleExchange', () => {
    it('should create 2-message exchange for raw sampling', () => {
      const exchange = createRawSampleExchange(
        'What is the weather?',
        'The weather is sunny and 72F.'
      )

      // Should have 2 messages
      expect(exchange.messages).toHaveLength(2)

      // Request should be user message
      expect(exchange.request.role).toBe('user')
      expect(exchange.request.content).toEqual([
        { type: 'text', text: 'What is the weather?' },
      ])

      // Response should be assistant message
      expect(exchange.response.role).toBe('assistant')
      expect(exchange.response.content).toEqual([
        { type: 'text', text: 'The weather is sunny and 72F.' },
      ])

      // Messages should be [request, response]
      expect(exchange.messages[0]).toBe(exchange.request)
      expect(exchange.messages[1]).toBe(exchange.response)

      // Parsed should be undefined
      expect(exchange.parsed).toBeUndefined()
    })

    it('should handle empty strings', () => {
      const exchange = createRawSampleExchange('', '')

      expect(exchange.messages).toHaveLength(2)
      expect(exchange.request.content).toEqual([{ type: 'text', text: '' }])
      expect(exchange.response.content).toEqual([{ type: 'text', text: '' }])
    })
  })

  describe('createStructuredSampleExchange', () => {
    it('should create 3-message exchange for structured output', () => {
      const parsed = { cell: 4, reason: 'center strategy' }
      const exchange = createStructuredSampleExchange(
        'Pick a cell (0-8)',
        parsed,
        'call_abc123'
      )

      // Should have 3 messages
      expect(exchange.messages).toHaveLength(3)

      // Request should be user message
      expect(exchange.request.role).toBe('user')
      expect(exchange.request.content).toEqual([
        { type: 'text', text: 'Pick a cell (0-8)' },
      ])

      // Response should be assistant with tool_use
      expect(exchange.response.role).toBe('assistant')
      expect(exchange.response.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_abc123',
          name: '__schema__',
          input: {},
        },
      ])

      // Third message should be tool_result with echoed parsed data
      const toolResult = exchange.messages[2]
      expect(toolResult?.role).toBe('user')
      expect(toolResult?.content).toEqual([
        {
          type: 'tool_result',
          toolUseId: 'call_abc123',
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
        },
      ])

      // Parsed should be the typed data
      expect(exchange.parsed).toEqual(parsed)
    })

    it('should preserve complex nested parsed data', () => {
      const parsed = {
        move: { cell: 4, confidence: 0.95 },
        alternatives: [{ cell: 0 }, { cell: 8 }],
      }
      const exchange = createStructuredSampleExchange(
        'Analyze the board',
        parsed,
        'call_xyz'
      )

      expect(exchange.parsed).toEqual(parsed)
      // The input in tool_use should be blank
      const content = exchange.response.content
      const toolUse = Array.isArray(content) ? content[0] : content
      expect(toolUse).toHaveProperty('input')
      expect((toolUse as { input: Record<string, unknown> }).input).toEqual({})
    })

    it('should handle null parsed value', () => {
    const exchange = createStructuredSampleExchange(
      'Try something',
      null,
      'call_null'
    )

    expect(exchange.parsed).toBeNull()
    expect(exchange.messages).toHaveLength(3)

    const toolResult = exchange.messages[2]
    const toolResultContent = Array.isArray(toolResult?.content)
      ? toolResult?.content[0]
      : toolResult?.content
    expect(toolResultContent).toHaveProperty('content')
    expect((toolResultContent as { content: Array<{ text: string }> }).content[0]?.text).toBe('null')
  })
  })
})

// =============================================================================
// URL ELICITATION GUARD
// =============================================================================

describe('URL elicitation guard', () => {
  it('should throw error when mode is url', () => {
    const event = {
      type: 'elicit_request' as const,
      lsn: 1,
      timestamp: Date.now(),
      elicitId: 'elicit_1',
      key: 'oauth',
      message: 'Please authorize',
      schema: { type: 'object' },
      mode: 'url', // This is the problematic mode
    } as ElicitRequestEvent & { mode?: string }

    expect(() => encodeElicitationRequest(event, 'req_1')).toThrow(
      'URL elicitation mode is not supported by sweatpants'
    )
  })

  it('should include helpful error message with spec link', () => {
    const event = {
      type: 'elicit_request' as const,
      lsn: 1,
      timestamp: Date.now(),
      elicitId: 'elicit_1',
      key: 'oauth',
      message: 'Please authorize',
      schema: { type: 'object' },
      mode: 'url',
    } as ElicitRequestEvent & { mode?: string }

    expect(() => encodeElicitationRequest(event, 'req_1')).toThrow(
      /https:\/\/modelcontextprotocol\.io\/specification/
    )
  })

  it('should work normally with form mode (explicit)', () => {
    const event = {
      type: 'elicit_request' as const,
      lsn: 1,
      timestamp: Date.now(),
      elicitId: 'elicit_1',
      key: 'confirm',
      message: 'Please confirm',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      mode: 'form',
    } as ElicitRequestEvent & { mode?: string }

    const request = encodeElicitationRequest(event, 'req_1')

    expect(request.params?.mode).toBe('form')
    expect(request.params?.message).toBe('Please confirm')
  })

  it('should work normally without mode (defaults to form)', () => {
    const event: ElicitRequestEvent = {
      type: 'elicit_request',
      lsn: 1,
      timestamp: Date.now(),
      elicitId: 'elicit_1',
      key: 'confirm',
      message: 'Please confirm',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }

    const request = encodeElicitationRequest(event, 'req_1')

    expect(request.params?.mode).toBe('form')
  })
})

// =============================================================================
// EXCHANGE MESSAGE COUNT CONSISTENCY
// =============================================================================

describe('Exchange message count consistency', () => {
  it('raw sample exchange always has exactly 2 messages', () => {
    const testCases = [
      { prompt: 'Short', response: 'Short reply' },
      { prompt: 'A'.repeat(1000), response: 'B'.repeat(2000) },
      { prompt: '', response: '' },
      { prompt: 'With\nnewlines', response: 'Also\nhas\nnewlines' },
    ]

    for (const { prompt, response } of testCases) {
      const exchange = createRawSampleExchange(prompt, response)
      expect(exchange.messages).toHaveLength(2)
      expect(exchange.messages[0]?.role).toBe('user')
      expect(exchange.messages[1]?.role).toBe('assistant')
    }
  })

  it('structured sample exchange always has exactly 3 messages', () => {
    const testCases = [
      { prompt: 'Pick', parsed: { cell: 0 }, id: 'call_1' },
      { prompt: 'Complex', parsed: { a: { b: { c: 1 } } }, id: 'call_2' },
      { prompt: 'Array', parsed: [1, 2, 3], id: 'call_3' },
      { prompt: 'Null', parsed: null, id: 'call_4' },
    ]

    for (const { prompt, parsed, id } of testCases) {
      const exchange = createStructuredSampleExchange(prompt, parsed, id)
      expect(exchange.messages).toHaveLength(3)
      expect(exchange.messages[0]?.role).toBe('user')
      expect(exchange.messages[1]?.role).toBe('assistant')
      expect(exchange.messages[2]?.role).toBe('user') // tool_result is in user message
    }
  })

  it('structured exchange tool_result references correct tool_use id', () => {
    const exchange = createStructuredSampleExchange(
      'Pick a move',
      { cell: 4 },
      'unique_call_id_123'
    )

    // Get tool_use id from response
    const responseContent = exchange.response.content
    const toolUse = Array.isArray(responseContent) ? responseContent[0] : responseContent
    expect(toolUse).toHaveProperty('id', 'unique_call_id_123')

    // Get tool_result toolUseId from third message
    const thirdMsg = exchange.messages[2]
    const thirdMsgContent = thirdMsg?.content
    const toolResult = Array.isArray(thirdMsgContent) ? thirdMsgContent[0] : thirdMsgContent
    expect(toolResult).toHaveProperty('toolUseId', 'unique_call_id_123')

    // Tool_result content should echo parsed data
    const toolResultContent = (toolResult as { content: Array<{ text: string }> }).content[0]
    expect(toolResultContent?.text).toBe(JSON.stringify({ cell: 4 }))
  })
})
