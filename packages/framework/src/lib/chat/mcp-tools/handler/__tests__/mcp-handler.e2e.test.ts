/**
 * MCP HTTP Handler End-to-End Tests
 *
 * Integration tests for the complete MCP Streamable HTTP flow,
 * including tool execution, elicitation, and sampling.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { createMcpTool } from '../../mcp-tool-builder'
import { createInMemoryToolSessionStore } from '../../session/in-memory-store'
import { createToolSessionRegistry } from '../../session/session-registry'
import { createMcpHandler } from '../mcp-handler'
import type { ToolSessionSamplingProvider, SampleResult } from '../../session/types'
import type { FinalizedMcpToolWithElicits } from '../../mcp-tool-builder'
import type { ElicitsMap } from '../../mcp-tool-types'
import { parseSseChunk } from '../../protocol/sse-formatter'

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock sampling provider for testing.
 */
function createMockSamplingProvider(
  responses: string[] = []
): ToolSessionSamplingProvider & { calls: Array<{ messages: unknown[] }> } {
  let callIndex = 0
  const calls: Array<{ messages: unknown[] }> = []

  return {
    calls,
    *sample(messages, _options) {
      calls.push({ messages })
      const text = responses[callIndex++] ?? `Response ${callIndex}`
      return { text } as SampleResult
    },
  }
}

/**
 * Read SSE events from a Response stream.
 */
async function _readSseEvents(response: Response): Promise<Array<{ id?: string | undefined; data: string }>> {
  const events: Array<{ id?: string | undefined; data: string }> = []
  const reader = response.body?.getReader()
  if (!reader) return events

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { events: parsed, remaining } = parseSseChunk(buffer)
      buffer = remaining

      for (const event of parsed) {
        const evt: { id?: string | undefined; data: string } = { data: event.data }
        if (event.id !== undefined) {
          evt.id = event.id
        }
        events.push(evt)
      }
    }
  } finally {
    reader.releaseLock()
  }

  return events
}

/**
 * Create a tools/call JSON-RPC request.
 */
function createToolsCallRequest(
  toolName: string,
  args: Record<string, unknown> = {},
  sessionId?: string
): Request {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId
  }

  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * Create an elicitation response JSON-RPC request.
 */
function _createElicitResponse(
  requestId: string | number,
  sessionId: string,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>
): Request {
  const body = {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      action,
      ...(content && { content }),
    },
  }

  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify(body),
  })
}

/**
 * Create a sampling response JSON-RPC request.
 */
function _createSampleResponse(
  requestId: string | number,
  sessionId: string,
  text: string,
  model: string = 'test-model'
): Request {
  const body = {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      role: 'assistant',
      content: { type: 'text', text },
      model,
    },
  }

  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify(body),
  })
}

/**
 * Create a GET request for SSE streaming.
 */
function _createSseRequest(sessionId: string, lastEventId?: string): Request {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Mcp-Session-Id': sessionId,
  }

  if (lastEventId) {
    headers['Last-Event-ID'] = lastEventId
  }

  return new Request('http://localhost/mcp', {
    method: 'GET',
    headers,
  })
}

/**
 * Create a DELETE request to terminate a session.
 */
function createTerminateRequest(sessionId: string): Request {
  return new Request('http://localhost/mcp', {
    method: 'DELETE',
    headers: {
      'Mcp-Session-Id': sessionId,
    },
  })
}

// =============================================================================
// TEST TOOLS
// =============================================================================

const simpleTool = createMcpTool('simple_tool')
  .description('A simple tool that returns immediately')
  .parameters(z.object({ input: z.string() }))
  .elicits({})
  .execute(function* (params) {
    return { result: `Echo: ${params.input}` }
  })

const progressTool = createMcpTool('progress_tool')
  .description('A tool that emits progress')
  .parameters(z.object({ steps: z.number() }))
  .elicits({})
  .execute(function* (params, ctx) {
    for (let i = 0; i < params.steps; i++) {
      yield* ctx.notify(`Step ${i + 1}/${params.steps}`, (i + 1) / params.steps)
    }
    return { completed: true, steps: params.steps }
  })

const elicitTool = createMcpTool('elicit_tool')
  .description('A tool that requests user input')
  .parameters(z.object({ question: z.string() }))
  .elicits({
    answer: z.object({ response: z.string() }),
  })
  .execute(function* (params, ctx) {
    const result = yield* ctx.elicit('answer', {
      message: params.question,
    })

    if (result.action === 'accept') {
      return { answered: true, response: result.content.response }
    }

    return { answered: false, action: result.action }
  })

// =============================================================================
// TESTS
// =============================================================================

describe('MCP HTTP Handler E2E', () => {
  let handler: ReturnType<typeof createMcpHandler>['handler']
  let samplingProvider: ReturnType<typeof createMockSamplingProvider>

  beforeEach(async () => {
    samplingProvider = createMockSamplingProvider(['Test response'])

    await run(function* () {
      const store = createInMemoryToolSessionStore()
      const registry = yield* createToolSessionRegistry(store, { samplingProvider })

      const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
      tools.set('simple_tool', simpleTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)
      tools.set('progress_tool', progressTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)
      tools.set('elicit_tool', elicitTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

      const result = createMcpHandler({
        registry,
        tools,
      })
      handler = result.handler
    })
  })

  describe('Simple tool execution', () => {
    it('should execute a simple tool and return JSON result', async () => {
      const request = createToolsCallRequest('simple_tool', { input: 'hello' })
      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('application/json')

      const body = await response.json()
      expect(body.jsonrpc).toBe('2.0')
      expect(body.id).toBe(1)
      expect(body.result).toBeDefined()
      expect(body.result.content).toBeDefined()

      // The result should contain the tool output
      const textContent = body.result.content.find((c: { type: string }) => c.type === 'text')
      expect(textContent).toBeDefined()
      expect(textContent.text).toContain('Echo: hello')
    })

    it('should return error for unknown tool', async () => {
      const request = createToolsCallRequest('unknown_tool', {})
      const response = await handler(request)

      expect(response.status).toBe(404)

      const body = await response.json()
      expect(body.error).toBeDefined()
    })
  })

  describe('Method validation', () => {
    it('should reject unsupported methods', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })

      const response = await handler(request)
      expect(response.status).toBe(405)
    })

    it('should reject GET without session ID', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      })

      const response = await handler(request)
      expect(response.status).toBe(400)
    })

    it('should reject GET without Accept: text/event-stream', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Mcp-Session-Id': 'test-session',
        },
      })

      const response = await handler(request)
      expect(response.status).toBe(406)
    })
  })

  describe('Session termination', () => {
    it('should terminate session with DELETE', async () => {
      // First create a session
      const createRequest = createToolsCallRequest('simple_tool', { input: 'test' })
      const createResponse = await handler(createRequest)
      const sessionId = createResponse.headers.get('Mcp-Session-Id')

      expect(sessionId).toBeDefined()

      // Then terminate it
      const deleteRequest = createTerminateRequest(sessionId!)
      const deleteResponse = await handler(deleteRequest)

      expect(deleteResponse.status).toBe(204)
    })

    it('should reject DELETE without session ID', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'DELETE',
      })

      const response = await handler(request)
      expect(response.status).toBe(400)
    })
  })

  describe('JSON-RPC validation', () => {
    it('should reject invalid JSON body', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      })

      const response = await handler(request)
      expect(response.status).toBe(400)
    })

    it('should reject non-JSON-RPC body', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })

      const response = await handler(request)
      expect(response.status).toBe(400)
    })

    it('should reject missing tool name', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {},
        }),
      })

      const response = await handler(request)
      expect(response.status).toBe(400)
    })
  })

  describe('Content-Type validation', () => {
    it('should reject non-JSON content type', async () => {
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      })

      const response = await handler(request)
      expect(response.status).toBe(415)
    })
  })
})

describe('MCP HTTP Handler - Session Headers', () => {
  let handler: ReturnType<typeof createMcpHandler>['handler']

  beforeEach(async () => {
    const samplingProvider = createMockSamplingProvider()

    await run(function* () {
      const store = createInMemoryToolSessionStore()
      const registry = yield* createToolSessionRegistry(store, { samplingProvider })

      const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
      tools.set('simple_tool', simpleTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

      const result = createMcpHandler({
        registry,
        tools,
      })
      handler = result.handler
    })
  })

  it('should return Mcp-Session-Id header in response', async () => {
    const request = createToolsCallRequest('simple_tool', { input: 'test' })
    const response = await handler(request)

    const sessionId = response.headers.get('Mcp-Session-Id')
    expect(sessionId).toBeDefined()
    expect(sessionId).toMatch(/^session_/)
  })
})
