/**
 * SSE (Server-Sent Events) Formatter
 *
 * Formats MCP JSON-RPC messages as SSE events for the Streamable HTTP transport.
 *
 * ## SSE Format
 *
 * Each SSE event has:
 * - `id`: Event ID for resumability (based on session LSN)
 * - `event`: Event type (optional, defaults to 'message')
 * - `data`: JSON-stringified message
 * - `retry`: Reconnection interval (optional)
 *
 * ## Resumability
 *
 * Per MCP spec, event IDs enable client reconnection:
 * 1. Server assigns unique IDs per stream within a session
 * 2. Client can reconnect with `Last-Event-ID` header
 * 3. Server replays events after that ID
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery
 * @packageDocumentation
 */
import type { SseEvent } from './types'

// =============================================================================
// EVENT ID GENERATION
// =============================================================================

/**
 * Generate an SSE event ID from session ID and LSN.
 *
 * Format: `{sessionId}:{lsn}`
 *
 * This encodes enough information to:
 * 1. Identify the stream (via sessionId)
 * 2. Identify the position (via LSN)
 */
export function generateEventId(sessionId: string, lsn: number): string {
  return `${sessionId}:${lsn}`
}

/**
 * Parse an SSE event ID back to session ID and LSN.
 *
 * @returns Parsed components, or null if invalid format
 */
export function parseEventId(eventId: string): { sessionId: string; lsn: number } | null {
  const colonIndex = eventId.lastIndexOf(':')
  if (colonIndex === -1) return null

  const sessionId = eventId.slice(0, colonIndex)
  const lsnStr = eventId.slice(colonIndex + 1)
  const lsn = parseInt(lsnStr, 10)

  if (isNaN(lsn)) return null

  return { sessionId, lsn }
}

// =============================================================================
// SSE FORMATTING
// =============================================================================

/**
 * Format an SSE event as a string for streaming.
 *
 * Per the SSE standard:
 * - Lines are separated by `\n`
 * - Event ends with `\n\n`
 * - Multi-line data splits into multiple `data:` lines
 */
export function formatSseEvent(event: SseEvent): string {
  const lines: string[] = []

  // Event ID (for resumability)
  if (event.id !== undefined) {
    lines.push(`id: ${event.id}`)
  }

  // Event type (if not default 'message')
  if (event.event !== undefined) {
    lines.push(`event: ${event.event}`)
  }

  // Retry interval
  if (event.retry !== undefined) {
    lines.push(`retry: ${event.retry}`)
  }

  // Data - split multi-line data into separate data: lines
  const dataLines = event.data.split('\n')
  for (const line of dataLines) {
    lines.push(`data: ${line}`)
  }

  // End with double newline
  return lines.join('\n') + '\n\n'
}

/**
 * Format a JSON-RPC message as an SSE event.
 */
export function formatMessageAsSse(
  message: unknown,
  sessionId: string,
  lsn: number,
  eventType?: string
): string {
  const event: SseEvent = {
    id: generateEventId(sessionId, lsn),
    data: JSON.stringify(message),
  }

  if (eventType !== undefined) {
    event.event = eventType
  }

  return formatSseEvent(event)
}

// =============================================================================
// STREAM PRIMING
// =============================================================================

/**
 * Create an SSE "prime" event.
 *
 * Per MCP spec, servers SHOULD send an initial event with an event ID
 * and empty data to prime the client for reconnection.
 */
export function createPrimeEvent(sessionId: string, retryMs?: number): string {
  const event: SseEvent = {
    id: generateEventId(sessionId, 0),
    data: '',
  }

  if (retryMs !== undefined) {
    event.retry = retryMs
  }

  return formatSseEvent(event)
}

/**
 * Create an SSE event indicating the server is closing the connection.
 *
 * Per MCP spec, when closing a connection before the stream ends,
 * servers SHOULD send a retry field to indicate when the client should reconnect.
 */
export function createCloseEvent(
  sessionId: string,
  lsn: number,
  retryMs: number = 1000
): string {
  const event: SseEvent = {
    id: generateEventId(sessionId, lsn),
    data: '',
    retry: retryMs,
  }

  return formatSseEvent(event)
}

// =============================================================================
// SSE PARSER (for testing/client use)
// =============================================================================

/**
 * Parse an SSE event from a string.
 *
 * @param raw - Raw SSE event string (including trailing \n\n)
 * @returns Parsed event, or null if invalid
 */
export function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split('\n')
  let id: string | undefined
  let event: string | undefined
  let retry: number | undefined
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('id:')) {
      id = line.slice(3).trim()
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('retry:')) {
      const retryStr = line.slice(6).trim()
      const parsed = parseInt(retryStr, 10)
      if (!isNaN(parsed)) {
        retry = parsed
      }
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
    // Skip empty lines and comments (lines starting with :)
  }

  // Must have at least one data line
  if (dataLines.length === 0) {
    return null
  }

  const result: SseEvent = {
    data: dataLines.join('\n'),
  }

  if (id !== undefined) result.id = id
  if (event !== undefined) result.event = event
  if (retry !== undefined) result.retry = retry

  return result
}

/**
 * Parse multiple SSE events from a stream chunk.
 *
 * @param chunk - Raw chunk containing one or more SSE events
 * @returns Array of parsed events and any remaining incomplete data
 */
export function parseSseChunk(chunk: string): { events: SseEvent[]; remaining: string } {
  const events: SseEvent[] = []
  const parts = chunk.split('\n\n')

  // Last part might be incomplete
  const remaining = parts.pop() ?? ''

  for (const part of parts) {
    if (part.trim() === '') continue
    const event = parseSseEvent(part + '\n\n')
    if (event) {
      events.push(event)
    }
  }

  return { events, remaining }
}

// =============================================================================
// SSE STREAM HELPERS
// =============================================================================

/**
 * Create an SSE stream headers object.
 */
export function createSseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  }
}

/**
 * SSE stream writer interface.
 */
export interface SseWriter {
  /**
   * Write an SSE event to the stream.
   */
  write(message: unknown, lsn: number, eventType?: string): void

  /**
   * Write a raw SSE event string.
   */
  writeRaw(data: string): void

  /**
   * Close the stream.
   */
  close(): void
}

/**
 * Create an SSE writer that writes to a writable stream.
 */
export function createSseWriter(
  sessionId: string,
  write: (data: string) => void,
  close: () => void
): SseWriter {
  return {
    write(message: unknown, lsn: number, eventType?: string) {
      const formatted = formatMessageAsSse(message, sessionId, lsn, eventType)
      write(formatted)
    },
    writeRaw(data: string) {
      write(data)
    },
    close() {
      close()
    },
  }
}
