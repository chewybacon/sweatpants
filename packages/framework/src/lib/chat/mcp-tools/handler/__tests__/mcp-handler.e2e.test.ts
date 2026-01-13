/**
 * MCP HTTP Handler End-to-End Tests
 *
 * Integration tests for the complete MCP Streamable HTTP flow,
 * including tool execution, elicitation, and sampling.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { createMcpTool } from '../../mcp-tool-builder.ts'
import { createInMemoryToolSessionStore } from '../../session/in-memory-store.ts'
import { createToolSessionRegistry } from '../../session/session-registry.ts'
import { createMcpHandler, generateMcpManifest } from '../mcp-handler.ts'
import type { ToolSessionSamplingProvider, SampleResult } from '../../session/types.ts'
import type { FinalizedMcpToolWithElicits } from '../../mcp-tool-builder.ts'
import type { ElicitsMap } from '../../mcp-tool-types.ts'
import { parseSseChunk } from '../../protocol/sse-formatter.ts'

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
    answer: {
      response: z.object({ response: z.string() }),
    },
  })
  .execute(function* (params, ctx) {
    const result = yield* ctx.elicit('answer', {
      message: params.question,
    })

    if (result.action === 'accept') {
      return { answered: true, response: (result.content as { response: string }).response }
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
    it('should execute a simple tool and return SSE stream with result', async () => {
      // Per design: tools/call always upgrades to SSE due to Effection scope lifecycle
      const request = createToolsCallRequest('simple_tool', { input: 'hello' })
      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('text/event-stream')
      expect(response.headers.get('Mcp-Session-Id')).toBeDefined()

      // Read events from SSE stream
      const events = await _readSseEvents(response)
      expect(events.length).toBeGreaterThan(0)

      // Find the result event
      const resultEvent = events.find((e) => {
        try {
          const parsed = JSON.parse(e.data)
          return parsed.result?.content !== undefined
        } catch {
          return false
        }
      })

      expect(resultEvent).toBeDefined()
      const result = JSON.parse(resultEvent!.data)
      expect(result.jsonrpc).toBe('2.0')
      expect(result.id).toBe(1)
      expect(result.result.content).toBeDefined()

      // The result should contain the tool output
      const textContent = result.result.content.find((c: { type: string }) => c.type === 'text')
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

    it('should return idle SSE stream for GET without session ID', async () => {
      // Per design: GET without session ID returns an idle SSE stream
      // for general server notifications (not tool-specific)
      const request = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      })

      const response = await handler(request)
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('text/event-stream')
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

// =============================================================================
// TOOLS/LIST WITH x-sweatpants EXTENSION TESTS
// =============================================================================

/**
 * Create a tools/list JSON-RPC request.
 */
function createToolsListRequest(): Request {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }

  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('MCP HTTP Handler - tools/list with x-sweatpants extension', () => {
  it('should include _meta.x-sweatpants.elicits for tools with elicit definitions', async () => {
    const samplingProvider = createMockSamplingProvider()

    const { handler } = await run(function* () {
      const store = createInMemoryToolSessionStore()
      const registry = yield* createToolSessionRegistry(store, { samplingProvider })

      // Create a tool with elicits
      const toolWithElicits = createMcpTool('tool_with_elicits')
        .description('A tool with elicitation')
        .parameters(z.object({ query: z.string() }))
        .elicits({
          confirmChoice: {
            response: z.object({ choice: z.string() }),
            context: z.object({ options: z.array(z.string()) }),
          },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('confirmChoice', {
            message: 'Choose one',
            options: ['a', 'b', 'c'],
          })
          return { selected: result.action === 'accept' }
        })

      const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
      tools.set('tool_with_elicits', toolWithElicits as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

      return createMcpHandler({ registry, tools })
    })

    const request = createToolsListRequest()
    const response = await handler(request)

    expect(response.status).toBe(200)

    const body = await response.json() as { result: { tools: Array<{ name: string; _meta?: { 'x-sweatpants'?: { elicits?: Record<string, unknown> } } }> } }
    expect(body.result.tools).toHaveLength(1)

    const tool = body.result.tools[0]!
    expect(tool.name).toBe('tool_with_elicits')
    expect(tool._meta).toBeDefined()
    expect(tool._meta?.['x-sweatpants']).toBeDefined()
    expect(tool._meta?.['x-sweatpants']?.elicits).toBeDefined()
    expect(tool._meta?.['x-sweatpants']?.elicits?.['confirmChoice']).toBeDefined()

    // Verify the response schema is included
    const elicit = tool._meta?.['x-sweatpants']?.elicits?.['confirmChoice'] as { response?: Record<string, unknown>; context?: Record<string, unknown> } | undefined
    expect(elicit?.response).toBeDefined()
    expect(elicit?.response?.['type']).toBe('object')

    // Verify the context schema is included
    expect(elicit?.context).toBeDefined()
    expect(elicit?.context?.['type']).toBe('object')
  })

  it('should include _meta.x-sweatpants.requires for tools with capability requirements', async () => {
    const samplingProvider = createMockSamplingProvider()

    const { handler } = await run(function* () {
      const store = createInMemoryToolSessionStore()
      const registry = yield* createToolSessionRegistry(store, { samplingProvider })

      // Create a tool with requires
      const toolWithRequires = createMcpTool('tool_with_requires')
        .description('A tool that requires elicitation')
        .parameters(z.object({}))
        .requires({ elicitation: true })
        .elicits({
          confirm: {
            response: z.object({ ok: z.boolean() }),
          },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('confirm', { message: 'Confirm?' })
          return { confirmed: result.action === 'accept' }
        })

      const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
      tools.set('tool_with_requires', toolWithRequires as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

      return createMcpHandler({ registry, tools })
    })

    const request = createToolsListRequest()
    const response = await handler(request)

    expect(response.status).toBe(200)

    const body = await response.json() as { result: { tools: Array<{ name: string; _meta?: { 'x-sweatpants'?: { requires?: { elicitation?: boolean } } } }> } }
    const tool = body.result.tools[0]!

    expect(tool._meta?.['x-sweatpants']?.requires).toBeDefined()
    expect(tool._meta?.['x-sweatpants']?.requires?.elicitation).toBe(true)
  })

  it('should NOT include _meta for tools without elicits or requires', async () => {
    const samplingProvider = createMockSamplingProvider()

    const { handler } = await run(function* () {
      const store = createInMemoryToolSessionStore()
      const registry = yield* createToolSessionRegistry(store, { samplingProvider })

      // Create a simple tool without elicits
      const simpleTool = createMcpTool('no_elicits_tool')
        .description('A simple tool')
        .parameters(z.object({ name: z.string() }))
        .elicits({})
        .execute(function* (params) {
          return { greeting: `Hello, ${params.name}!` }
        })

      const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
      tools.set('no_elicits_tool', simpleTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

      return createMcpHandler({ registry, tools })
    })

    const request = createToolsListRequest()
    const response = await handler(request)

    expect(response.status).toBe(200)

    const body = await response.json() as { result: { tools: Array<{ name: string; _meta?: unknown }> } }
    const tool = body.result.tools[0]!

    // No _meta should be present for tools without elicits or requires
    expect(tool._meta).toBeUndefined()
  })

  it('should serialize multiple elicit keys correctly', async () => {
    const samplingProvider = createMockSamplingProvider()

    const { handler } = await run(function* () {
      const store = createInMemoryToolSessionStore()
      const registry = yield* createToolSessionRegistry(store, { samplingProvider })

      // Create a tool with multiple elicit keys
      const multiElicitTool = createMcpTool('multi_elicit_tool')
        .description('A tool with multiple elicitation points')
        .parameters(z.object({}))
        .elicits({
          selectFlight: {
            response: z.object({ flightId: z.string() }),
            context: z.object({ flights: z.array(z.object({ id: z.string(), price: z.number() })) }),
          },
          selectSeat: {
            response: z.object({ seatNumber: z.string() }),
            context: z.object({ availableSeats: z.array(z.string()) }),
          },
          confirmBooking: {
            response: z.object({ confirmed: z.boolean() }),
          },
        })
        .execute(function* (_params, ctx) {
          yield* ctx.elicit('selectFlight', { message: 'Pick flight', flights: [] })
          yield* ctx.elicit('selectSeat', { message: 'Pick seat', availableSeats: [] })
          yield* ctx.elicit('confirmBooking', { message: 'Confirm?' })
          return { booked: true }
        })

      const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
      tools.set('multi_elicit_tool', multiElicitTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

      return createMcpHandler({ registry, tools })
    })

    const request = createToolsListRequest()
    const response = await handler(request)

    expect(response.status).toBe(200)

    const body = await response.json() as { result: { tools: Array<{ name: string; _meta?: { 'x-sweatpants'?: { elicits?: Record<string, unknown> } } }> } }
    const tool = body.result.tools[0]!

    const elicits = tool._meta?.['x-sweatpants']?.elicits
    expect(elicits).toBeDefined()
    expect(Object.keys(elicits!)).toEqual(['selectFlight', 'selectSeat', 'confirmBooking'])

    // selectFlight has both response and context
    const selectFlight = elicits?.['selectFlight'] as { response?: unknown; context?: unknown } | undefined
    expect(selectFlight?.response).toBeDefined()
    expect(selectFlight?.context).toBeDefined()

    // confirmBooking has only response (no context)
    const confirmBooking = elicits?.['confirmBooking'] as { response?: unknown; context?: unknown } | undefined
    expect(confirmBooking?.response).toBeDefined()
    expect(confirmBooking?.context).toBeUndefined()
  })
})

// =============================================================================
// generateMcpManifest TESTS
// =============================================================================

describe('generateMcpManifest', () => {
  it('should generate a valid manifest with server info', () => {
    const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
    
    const manifest = generateMcpManifest(tools, {
      name: 'Test Server',
      version: '2.0.0',
      description: 'A test server',
      endpoint: '/api/mcp',
    })

    expect(manifest.version).toBe('1.0')
    expect(manifest.server.name).toBe('Test Server')
    expect(manifest.server.version).toBe('2.0.0')
    expect(manifest.server.description).toBe('A test server')
    expect(manifest.mcp.endpoint).toBe('/api/mcp')
    expect(manifest.mcp.protocolVersion).toBe('2024-11-05')
    expect(manifest.tools).toEqual([])
  })

  it('should use defaults when options not provided', () => {
    const tools = new Map()
    const manifest = generateMcpManifest(tools)

    expect(manifest.server.name).toBe('mcp-server')
    expect(manifest.server.version).toBe('1.0.0')
    expect(manifest.server.description).toBeUndefined()
    expect(manifest.mcp.endpoint).toBe('/mcp')
  })

  it('should include tools with x-sweatpants extension', () => {
    const toolWithElicits = createMcpTool('test_tool')
      .description('A test tool')
      .parameters(z.object({ name: z.string() }))
      .elicits({
        confirm: {
          response: z.object({ ok: z.boolean() }),
          context: z.object({ message: z.string() }),
        },
      })
      .execute(function* (_params, ctx) {
        yield* ctx.elicit('confirm', { message: 'Confirm?' })
        return { done: true }
      })

    const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
    tools.set('test_tool', toolWithElicits as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

    const manifest = generateMcpManifest(tools, { name: 'Test' })

    expect(manifest.tools).toHaveLength(1)
    expect(manifest.tools[0]!.name).toBe('test_tool')
    expect(manifest.tools[0]!.description).toBe('A test tool')
    expect(manifest.tools[0]!.inputSchema).toBeDefined()
    expect(manifest.tools[0]!._meta?.['x-sweatpants']?.elicits?.['confirm']).toBeDefined()
    
    const elicit = manifest.tools[0]!._meta?.['x-sweatpants']?.elicits?.['confirm']
    expect(elicit?.response).toBeDefined()
    expect(elicit?.context).toBeDefined()
  })

  it('should include requires in manifest', () => {
    const toolWithRequires = createMcpTool('requiring_tool')
      .description('Requires elicitation')
      .parameters(z.object({}))
      .requires({ elicitation: true, sampling: true })
      .elicits({
        ask: { response: z.object({ answer: z.string() }) },
      })
      .execute(function* (_params, ctx) {
        yield* ctx.elicit('ask', { message: 'Question?' })
        return {}
      })

    const tools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
    tools.set('requiring_tool', toolWithRequires as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>)

    const manifest = generateMcpManifest(tools)

    const requires = manifest.tools[0]!._meta?.['x-sweatpants']?.requires
    expect(requires).toBeDefined()
    expect(requires?.elicitation).toBe(true)
    expect(requires?.sampling).toBe(true)
  })
})
