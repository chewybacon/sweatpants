/**
 * Durable stream protocol header helpers.
 *
 * Keeps protocol-specific parsing/formatting logic separate from handler flow.
 */

export interface StreamMetadata {
  tailOffset: number
  closed: boolean
}

export interface ParsedOffset {
  value: number | null
  isNow: boolean
}

export type LiveMode = 'long-poll' | 'sse'

const OFFSET_WIDTH = 16

/**
 * Extracts `/sessions/{sessionId}` from a URL pathname.
 */
export function parseSessionIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/sessions\/([^/]+)/)
  if (!match?.[1]) {
    return undefined
  }
  return decodeURIComponent(match[1])
}

/**
 * Parses protocol offset from query params.
 *
 * Supports integer offsets only in phase 1.
 */
export function parseOffsetParam(value: string | null): ParsedOffset {
  if (value === null) {
    return { value: null, isNow: false }
  }

  if (value === 'now') {
    return { value: null, isNow: true }
  }

  if (value === '-1') {
    return { value: 0, isNow: false }
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return { value: null, isNow: false }
  }
  return { value: parsed, isNow: false }
}

export function parseLiveMode(value: string | null): LiveMode | undefined {
  if (value === 'long-poll' || value === 'sse') {
    return value
  }
  return undefined
}

/**
 * Parses `timeout` query parameter (seconds) into milliseconds.
 */
export function parseTimeoutMs(value: string | null, fallbackMs = 30_000): number {
  if (value === null) {
    return fallbackMs
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return fallbackMs
  }
  return parsed * 1000
}

export function toOffsetString(offset: number): string {
  return String(offset).padStart(OFFSET_WIDTH, '0')
}

export function createStreamCursor(now = Date.now(), intervalMs = 20_000): string {
  return String(Math.floor(now / intervalMs))
}

/**
 * ETag for offset snapshots.
 */
export function createStreamETag(
  sessionId: string,
  startOffset: number,
  metadata: StreamMetadata,
): string {
  const closedMarker = metadata.closed ? 'c' : 'o'
  return `"${sessionId}:${startOffset}:${metadata.tailOffset}:${closedMarker}"`
}

/**
 * Applies protocol metadata headers for a response snapshot.
 */
export function applySnapshotHeaders(
  headers: Headers,
  startOffset: number,
  metadata: StreamMetadata,
): void {
  headers.set('Stream-Next-Offset', toOffsetString(metadata.tailOffset))

  if (startOffset >= metadata.tailOffset) {
    headers.set('Stream-Up-To-Date', 'true')
    if (metadata.closed) {
      headers.set('Stream-Closed', 'true')
    }
  }
}
