/**
 * MCP HTTP Handler Tests
 *
 * Tests for the MCP Streamable HTTP handler implementation.
 */
import { describe, it, expect } from 'vitest'
import {
  parseHeaders,
  validatePostHeaders,
  validateGetHeaders,
  classifyRequest,
} from '../request-parser.ts'
import { McpHandlerError } from '../types.ts'
import type { McpParsedRequest } from '../types.ts'

// =============================================================================
// REQUEST PARSER TESTS
// =============================================================================

describe('request-parser', () => {
  describe('parseHeaders', () => {
    it('parses Mcp-Session-Id header', () => {
      const request = new Request('http://localhost/mcp', {
        headers: { 'Mcp-Session-Id': 'session-123' },
      })

      const headers = parseHeaders(request)
      expect(headers.sessionId).toBe('session-123')
    })

    it('parses Last-Event-ID header', () => {
      const request = new Request('http://localhost/mcp', {
        headers: { 'Last-Event-ID': 'session-123:42' },
      })

      const headers = parseHeaders(request)
      expect(headers.lastEventId).toBe('session-123:42')
    })

    it('parses Accept header', () => {
      const request = new Request('http://localhost/mcp', {
        headers: { Accept: 'text/event-stream' },
      })

      const headers = parseHeaders(request)
      expect(headers.accept).toBe('text/event-stream')
    })

    it('parses Content-Type header', () => {
      const request = new Request('http://localhost/mcp', {
        headers: { 'Content-Type': 'application/json' },
      })

      const headers = parseHeaders(request)
      expect(headers.contentType).toBe('application/json')
    })

    it('returns empty object when no headers present', () => {
      const request = new Request('http://localhost/mcp')
      const headers = parseHeaders(request)

      expect(headers.sessionId).toBeUndefined()
      expect(headers.lastEventId).toBeUndefined()
      expect(headers.accept).toBeUndefined()
      expect(headers.contentType).toBeUndefined()
    })
  })

  describe('validatePostHeaders', () => {
    it('accepts application/json content type', () => {
      expect(() => validatePostHeaders({ contentType: 'application/json' })).not.toThrow()
    })

    it('accepts application/json with charset', () => {
      expect(() =>
        validatePostHeaders({ contentType: 'application/json; charset=utf-8' })
      ).not.toThrow()
    })

    it('rejects non-JSON content type', () => {
      expect(() => validatePostHeaders({ contentType: 'text/plain' })).toThrow(
        McpHandlerError
      )
    })

    it('accepts missing content type', () => {
      expect(() => validatePostHeaders({})).not.toThrow()
    })
  })

  describe('validateGetHeaders', () => {
    it('accepts text/event-stream', () => {
      expect(() => validateGetHeaders({ accept: 'text/event-stream' })).not.toThrow()
    })

    it('accepts text/event-stream among multiple types', () => {
      expect(() =>
        validateGetHeaders({ accept: 'application/json, text/event-stream' })
      ).not.toThrow()
    })

    it('rejects missing accept header', () => {
      expect(() => validateGetHeaders({})).toThrow(McpHandlerError)
    })

    it('rejects non-SSE accept header', () => {
      expect(() => validateGetHeaders({ accept: 'application/json' })).toThrow(
        McpHandlerError
      )
    })
  })

  describe('classifyRequest', () => {
    describe('POST requests', () => {
      it('classifies tools/call request', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: {},
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'my_tool', arguments: { foo: 'bar' } },
          },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('tools_call')
        if (result.type === 'tools_call') {
          expect(result.requestId).toBe(1)
          expect(result.toolName).toBe('my_tool')
          expect(result.arguments).toEqual({ foo: 'bar' })
        }
      })

      it('classifies tools/call with session ID', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: { sessionId: 'session-123' },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'my_tool' },
          },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('tools_call')
        if (result.type === 'tools_call') {
          expect(result.sessionId).toBe('session-123')
        }
      })

      it('classifies elicitation response', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: { sessionId: 'session-123' },
          body: {
            jsonrpc: '2.0',
            id: 'req_1',
            result: { action: 'accept', content: { email: 'test@example.com' } },
          },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('elicit_response')
        if (result.type === 'elicit_response') {
          expect(result.requestId).toBe('req_1')
          expect(result.action).toBe('accept')
          expect(result.content).toEqual({ email: 'test@example.com' })
          expect(result.sessionId).toBe('session-123')
        }
      })

      it('classifies sampling response', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: { sessionId: 'session-123' },
          body: {
            jsonrpc: '2.0',
            id: 'req_2',
            result: {
              role: 'assistant',
              content: { type: 'text', text: 'Hello!' },
              model: 'claude-3-opus',
              stopReason: 'endTurn',
            },
          },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('sample_response')
        if (result.type === 'sample_response') {
          expect(result.requestId).toBe('req_2')
          expect(result.role).toBe('assistant')
          expect(result.model).toBe('claude-3-opus')
          expect(result.stopReason).toBe('endTurn')
          expect(result.sessionId).toBe('session-123')
        }
      })

      it('rejects response without session ID', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: {},
          body: {
            jsonrpc: '2.0',
            id: 'req_1',
            result: { action: 'accept' },
          },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        expect(() => classifyRequest(parsed)).toThrow(McpHandlerError)
      })

      it('rejects unsupported method', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: {},
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'resources/read',
            params: {},
          },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        expect(() => classifyRequest(parsed)).toThrow(McpHandlerError)
      })

      it('rejects non-JSON-RPC body', () => {
        const parsed: McpParsedRequest = {
          method: 'POST',
          headers: {},
          body: { foo: 'bar' },
          originalRequest: new Request('http://localhost/mcp', { method: 'POST' }),
        }

        expect(() => classifyRequest(parsed)).toThrow(McpHandlerError)
      })
    })

    describe('GET requests', () => {
      it('classifies SSE stream request', () => {
        const parsed: McpParsedRequest = {
          method: 'GET',
          headers: { sessionId: 'session-123', accept: 'text/event-stream' },
          originalRequest: new Request('http://localhost/mcp'),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('sse_stream')
        if (result.type === 'sse_stream') {
          expect(result.sessionId).toBe('session-123')
          expect(result.afterLSN).toBeUndefined()
        }
      })

      it('parses Last-Event-ID for resumability', () => {
        const parsed: McpParsedRequest = {
          method: 'GET',
          headers: {
            sessionId: 'session-123',
            lastEventId: 'session-123:42',
            accept: 'text/event-stream',
          },
          originalRequest: new Request('http://localhost/mcp'),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('sse_stream')
        if (result.type === 'sse_stream') {
          expect(result.afterLSN).toBe(42)
        }
      })

      it('ignores Last-Event-ID for different session', () => {
        const parsed: McpParsedRequest = {
          method: 'GET',
          headers: {
            sessionId: 'session-123',
            lastEventId: 'other-session:42',
            accept: 'text/event-stream',
          },
          originalRequest: new Request('http://localhost/mcp'),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('sse_stream')
        if (result.type === 'sse_stream') {
          expect(result.afterLSN).toBeUndefined()
        }
      })

      it('returns idle stream for GET without session ID', () => {
        // Per design: GET without session ID returns an idle SSE stream
        // for general server notifications (not tool-specific)
        const parsed: McpParsedRequest = {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          originalRequest: new Request('http://localhost/mcp'),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('sse_stream')
        if (result.type === 'sse_stream') {
          expect(result.sessionId).toBe('') // Empty = idle stream
        }
      })
    })

    describe('DELETE requests', () => {
      it('classifies terminate request', () => {
        const parsed: McpParsedRequest = {
          method: 'DELETE',
          headers: { sessionId: 'session-123' },
          originalRequest: new Request('http://localhost/mcp', { method: 'DELETE' }),
        }

        const result = classifyRequest(parsed)

        expect(result.type).toBe('terminate')
        if (result.type === 'terminate') {
          expect(result.sessionId).toBe('session-123')
        }
      })

      it('rejects DELETE without session ID', () => {
        const parsed: McpParsedRequest = {
          method: 'DELETE',
          headers: {},
          originalRequest: new Request('http://localhost/mcp', { method: 'DELETE' }),
        }

        expect(() => classifyRequest(parsed)).toThrow(McpHandlerError)
      })
    })
  })
})

// =============================================================================
// SSE FORMATTER INTEGRATION TESTS
// =============================================================================

describe('sse-formatter integration', () => {
  // These test the protocol layer which is already tested in protocol/__tests__
  // Here we just verify the handler uses it correctly
  it.todo('formats SSE events with correct event IDs')
  it.todo('supports resumability via Last-Event-ID')
})

// =============================================================================
// SESSION MANAGER TESTS
// =============================================================================

describe('session-manager', () => {
  // Session manager tests would require mocking the ToolSessionRegistry
  // These will be added in a follow-up
  it.todo('creates sessions for tools/call requests')
  it.todo('tracks pending elicitation requests')
  it.todo('routes elicitation responses correctly')
  it.todo('tracks pending sampling requests')
  it.todo('routes sampling responses correctly')
})
