/**
 * MCP Protocol Tests
 *
 * Tests for encoding/decoding MCP messages and SSE formatting.
 */
import { describe, it, expect } from 'vitest'
import {
  // Encoder
  encodeSessionEvent,
  createEncoderContext,
  encodeProgressNotification,
  encodeLogNotification,
  encodeElicitationRequest,
  encodeToolCallResult,

  // Decoder
  decodeElicitationResponse,
  decodeSamplingResponse,
  parseJsonRpcMessage,
  createDecoderContext,
  decodeResponse,

  // SSE
  formatSseEvent,
  formatMessageAsSse,
  parseSseEvent,
  parseSseChunk,
  generateEventId,
  parseEventId,
  createPrimeEvent,
  createCloseEvent,

  // Types
  isJsonRpcError,
  isJsonRpcSuccess,
} from '../index.ts'
import type {
  ProgressEvent,
  LogEvent,
  ElicitRequestEvent,
  ResultEvent,
} from '../../session/types.ts'

describe('MCP Protocol', () => {
  describe('Message Encoder', () => {
    describe('encodeProgressNotification', () => {
      it('should encode a progress event', () => {
        const event: ProgressEvent = {
          type: 'progress',
          lsn: 1,
          timestamp: Date.now(),
          message: 'Loading...',
          progress: 0.5,
        }

        const notification = encodeProgressNotification(event, 'progress_123')

        expect(notification.jsonrpc).toBe('2.0')
        expect(notification.method).toBe('notifications/progress')
        expect(notification.params?.progressToken).toBe('progress_123')
        expect(notification.params?.progress).toBe(0.5)
        expect(notification.params?.message).toBe('Loading...')
      })
    })

    describe('encodeLogNotification', () => {
      it('should encode a log event', () => {
        const event: LogEvent = {
          type: 'log',
          lsn: 2,
          timestamp: Date.now(),
          level: 'info',
          message: 'Processing complete',
        }

        const notification = encodeLogNotification(event, 'my-tool')

        expect(notification.jsonrpc).toBe('2.0')
        expect(notification.method).toBe('notifications/message')
        expect(notification.params?.level).toBe('info')
        expect(notification.params?.data).toBe('Processing complete')
        expect(notification.params?.logger).toBe('my-tool')
      })

      it('should omit logger when not provided', () => {
        const event: LogEvent = {
          type: 'log',
          lsn: 2,
          timestamp: Date.now(),
          level: 'warning',
          message: 'Warning message',
        }

        const notification = encodeLogNotification(event)

        expect(notification.params?.logger).toBeUndefined()
      })
    })

    describe('encodeElicitationRequest', () => {
      it('should encode an elicit request event', () => {
        const event: ElicitRequestEvent = {
          type: 'elicit_request',
          lsn: 3,
          timestamp: Date.now(),
          elicitId: 'elicit_123',
          key: 'confirm',
          message: 'Please confirm',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        }

        const request = encodeElicitationRequest(event, 'req_1')

        expect(request.jsonrpc).toBe('2.0')
        expect(request.id).toBe('req_1')
        expect(request.method).toBe('elicitation/create')
        expect(request.params?.mode).toBe('form')
        expect(request.params?.message).toBe('Please confirm')
        // For form mode, requestedSchema should be present
        const formParams = request.params as { mode?: string; message: string; requestedSchema: Record<string, unknown> }
        expect(formParams.requestedSchema).toEqual(event.schema)
      })
    })

    describe('encodeToolCallResult', () => {
      it('should encode a result event', () => {
        const event: ResultEvent<{ answer: number }> = {
          type: 'result',
          lsn: 10,
          timestamp: Date.now(),
          result: { answer: 42 },
        }

        const response = encodeToolCallResult(event, 'call_1')

        expect(response.jsonrpc).toBe('2.0')
        expect(response.id).toBe('call_1')
        expect(isJsonRpcSuccess(response)).toBe(true)
        if (isJsonRpcSuccess(response)) {
          expect(response.result.isError).toBe(false)
          expect(response.result.content).toHaveLength(1)
          expect(response.result.content[0]).toMatchObject({
            type: 'text',
            text: JSON.stringify({ answer: 42 }),
          })
        }
      })
    })

    describe('encodeSessionEvent', () => {
      it('should encode all event types', () => {
        const ctx = createEncoderContext('call_1', 'progress_1', 'test-logger')

        // Progress
        const progressEncoded = encodeSessionEvent<unknown>(
          { type: 'progress', lsn: 1, timestamp: Date.now(), message: 'Working...' },
          ctx
        )
        expect(progressEncoded.type).toBe('notification')

        // Log
        const logEncoded = encodeSessionEvent<unknown>(
          { type: 'log', lsn: 2, timestamp: Date.now(), level: 'info', message: 'Info' },
          ctx
        )
        expect(logEncoded.type).toBe('notification')

        // Elicit
        const elicitEncoded = encodeSessionEvent<unknown>(
          {
            type: 'elicit_request',
            lsn: 3,
            timestamp: Date.now(),
            elicitId: 'e1',
            key: 'confirm',
            message: 'Confirm?',
            schema: {},
          },
          ctx
        )
        expect(elicitEncoded.type).toBe('request')
        if (elicitEncoded.type === 'request') {
          expect(elicitEncoded.elicitId).toBe('e1')
        }

        // Result
        const resultEncoded = encodeSessionEvent(
          { type: 'result', lsn: 4, timestamp: Date.now(), result: 'done' },
          ctx
        )
        expect(resultEncoded.type).toBe('response')

        // Error
        const errorEncoded = encodeSessionEvent<unknown>(
          { type: 'error', lsn: 5, timestamp: Date.now(), name: 'Error', message: 'Failed' },
          ctx
        )
        expect(errorEncoded.type).toBe('response')

        // Cancelled
        const cancelledEncoded = encodeSessionEvent<unknown>(
          { type: 'cancelled', lsn: 6, timestamp: Date.now(), reason: 'User cancelled' },
          ctx
        )
        expect(cancelledEncoded.type).toBe('response')
      })
    })
  })

  describe('Message Decoder', () => {
    describe('decodeElicitationResponse', () => {
      it('should decode an accept response', () => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'req_1',
          result: {
            action: 'accept' as const,
            content: { confirmed: true },
          },
        }

        const decoded = decodeElicitationResponse(response, 'elicit_1')

        expect(decoded.type).toBe('elicitation_response')
        if (decoded.type === 'elicitation_response') {
          expect(decoded.elicitId).toBe('elicit_1')
          expect(decoded.result.action).toBe('accept')
          if (decoded.result.action === 'accept') {
            expect(decoded.result.content).toEqual({ confirmed: true })
          }
        }
      })

      it('should decode a decline response', () => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'req_1',
          result: { action: 'decline' as const },
        }

        const decoded = decodeElicitationResponse(response, 'elicit_1')

        expect(decoded.type).toBe('elicitation_response')
        if (decoded.type === 'elicitation_response') {
          expect(decoded.result.action).toBe('decline')
        }
      })

      it('should decode an error response', () => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'req_1',
          error: { code: -1, message: 'User rejected' },
        }

        const decoded = decodeElicitationResponse(response, 'elicit_1')

        expect(decoded.type).toBe('error')
        if (decoded.type === 'error') {
          expect(decoded.code).toBe(-1)
          expect(decoded.message).toBe('User rejected')
        }
      })
    })

    describe('decodeSamplingResponse', () => {
      it('should decode a sampling response', () => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'req_1',
          result: {
            role: 'assistant' as const,
            content: { type: 'text' as const, text: 'Hello!' },
            model: 'claude-3',
            stopReason: 'endTurn' as const,
          },
        }

        const decoded = decodeSamplingResponse(response, 'sample_1')

        expect(decoded.type).toBe('sampling_response')
        if (decoded.type === 'sampling_response') {
          expect(decoded.sampleId).toBe('sample_1')
          expect(decoded.result.text).toBe('Hello!')
          expect(decoded.result.model).toBe('claude-3')
        }
      })
    })

    describe('parseJsonRpcMessage', () => {
      it('should parse a request', () => {
        const raw = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'test' },
        })

        const parsed = parseJsonRpcMessage(raw)

        expect(parsed.type).toBe('request')
        if (parsed.type === 'request') {
          expect(parsed.message.method).toBe('tools/call')
        }
      })

      it('should parse a notification', () => {
        const raw = JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: 'p1', progress: 0.5 },
        })

        const parsed = parseJsonRpcMessage(raw)

        expect(parsed.type).toBe('notification')
      })

      it('should parse a success response', () => {
        const raw = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { data: 'test' },
        })

        const parsed = parseJsonRpcMessage(raw)

        expect(parsed.type).toBe('response')
        if (parsed.type === 'response') {
          expect(isJsonRpcSuccess(parsed.message)).toBe(true)
        }
      })

      it('should parse an error response', () => {
        const raw = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Invalid' },
        })

        const parsed = parseJsonRpcMessage(raw)

        expect(parsed.type).toBe('response')
        if (parsed.type === 'response') {
          expect(isJsonRpcError(parsed.message)).toBe(true)
        }
      })

      it('should handle invalid JSON', () => {
        const parsed = parseJsonRpcMessage('not json')

        expect(parsed.type).toBe('invalid')
        if (parsed.type === 'invalid') {
          expect(parsed.error).toBe('Invalid JSON')
        }
      })
    })

    describe('decodeResponse with context', () => {
      it('should correlate response with pending request', () => {
        const ctx = createDecoderContext()
        ctx.addPendingElicitation('req_1', 'elicit_123')

        const response = {
          jsonrpc: '2.0' as const,
          id: 'req_1',
          result: { action: 'accept' as const, content: { ok: true } },
        }

        const decoded = decodeResponse(response, ctx)

        expect(decoded.type).toBe('elicitation_response')
        if (decoded.type === 'elicitation_response') {
          expect(decoded.elicitId).toBe('elicit_123')
        }

        // Request should be removed from pending
        expect(ctx.pendingRequests.has('req_1')).toBe(false)
      })
    })
  })

  describe('SSE Formatter', () => {
    describe('formatSseEvent', () => {
      it('should format a basic event', () => {
        const formatted = formatSseEvent({ data: '{"test":1}' })

        expect(formatted).toBe('data: {"test":1}\n\n')
      })

      it('should format an event with all fields', () => {
        const formatted = formatSseEvent({
          id: 'event_1',
          event: 'message',
          data: '{"test":1}',
          retry: 1000,
        })

        expect(formatted).toContain('id: event_1\n')
        expect(formatted).toContain('event: message\n')
        expect(formatted).toContain('retry: 1000\n')
        expect(formatted).toContain('data: {"test":1}\n')
        expect(formatted.endsWith('\n\n')).toBe(true)
      })

      it('should handle multi-line data', () => {
        const formatted = formatSseEvent({ data: 'line1\nline2\nline3' })

        expect(formatted).toBe('data: line1\ndata: line2\ndata: line3\n\n')
      })
    })

    describe('formatMessageAsSse', () => {
      it('should format a JSON-RPC message as SSE', () => {
        const message = { jsonrpc: '2.0', method: 'test' }
        const formatted = formatMessageAsSse(message, 'session_1', 5)

        expect(formatted).toContain('id: session_1:5\n')
        expect(formatted).toContain('data: {"jsonrpc":"2.0","method":"test"}\n')
      })
    })

    describe('parseSseEvent', () => {
      it('should parse a formatted event', () => {
        const raw = 'id: evt_1\nevent: message\ndata: {"test":1}\n\n'
        const parsed = parseSseEvent(raw)

        expect(parsed).not.toBeNull()
        expect(parsed?.id).toBe('evt_1')
        expect(parsed?.event).toBe('message')
        expect(parsed?.data).toBe('{"test":1}')
      })

      it('should parse multi-line data', () => {
        const raw = 'data: line1\ndata: line2\n\n'
        const parsed = parseSseEvent(raw)

        expect(parsed).not.toBeNull()
        expect(parsed?.data).toBe('line1\nline2')
      })
    })

    describe('parseSseChunk', () => {
      it('should parse multiple events from a chunk', () => {
        const chunk = 'id: 1\ndata: a\n\nid: 2\ndata: b\n\n'
        const { events, remaining } = parseSseChunk(chunk)

        expect(events).toHaveLength(2)
        expect(events[0]?.id).toBe('1')
        expect(events[1]?.id).toBe('2')
        expect(remaining).toBe('')
      })

      it('should handle incomplete events', () => {
        const chunk = 'id: 1\ndata: a\n\nid: 2\ndata:'
        const { events, remaining } = parseSseChunk(chunk)

        expect(events).toHaveLength(1)
        expect(remaining).toBe('id: 2\ndata:')
      })
    })

    describe('Event ID handling', () => {
      it('should generate and parse event IDs', () => {
        const id = generateEventId('session_abc', 42)

        expect(id).toBe('session_abc:42')

        const parsed = parseEventId(id)

        expect(parsed).not.toBeNull()
        expect(parsed?.sessionId).toBe('session_abc')
        expect(parsed?.lsn).toBe(42)
      })

      it('should handle session IDs with colons', () => {
        const id = generateEventId('session:with:colons', 10)
        const parsed = parseEventId(id)

        expect(parsed?.sessionId).toBe('session:with:colons')
        expect(parsed?.lsn).toBe(10)
      })
    })

    describe('Stream control events', () => {
      it('should create prime event', () => {
        const event = createPrimeEvent('session_1', 3000)

        expect(event).toContain('id: session_1:0\n')
        expect(event).toContain('retry: 3000\n')
        expect(event).toContain('data: \n')
      })

      it('should create close event', () => {
        const event = createCloseEvent('session_1', 10, 5000)

        expect(event).toContain('id: session_1:10\n')
        expect(event).toContain('retry: 5000\n')
      })
    })
  })
})
