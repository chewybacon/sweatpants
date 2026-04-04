/**
 * Web Stream Bridge
 *
 * Bridges Effection-based TokenBuffers to Web ReadableStreams,
 * enabling use with standard HTTP Response objects.
 *
 * This module wraps the generic stream-bridge with TokenBuffer-specific logic.
 */
import { createReadableStream } from '@sweatpants/stream-bridge'
import type { Scope } from 'effection'
import type { TokenBuffer, TokenFrame } from '@sweatpants/durable-streams'
import { createPullStream } from '@sweatpants/durable-streams'

/**
 * Creates a Web ReadableStream from a TokenBuffer.
 *
 * The stream outputs NDJSON (newline-delimited JSON) where each line
 * is a TokenFrame: `{"token": "...", "lsn": 1}\n`
 *
 * @param scope - Effection scope for running operations in pull callbacks
 * @param buffer - TokenBuffer to read from
 * @param startLSN - Starting position (default 0, or last known LSN for reconnect)
 * @returns Web ReadableStream<Uint8Array>
 *
 * @example
 * ```typescript
 * const scope = yield* useScope()
 * const webStream = createWebStreamFromBuffer(scope, session.buffer)
 * const response = new Response(webStream, {
 *   headers: { 'content-type': 'application/x-ndjson' }
 * })
 * ```
 */
export function createWebStreamFromBuffer(
  scope: Scope,
  buffer: TokenBuffer<string>,
  startLSN = 0
): ReadableStream<Uint8Array> {
  const stream = createPullStream(buffer, startLSN)
  const encoder = new TextEncoder()

  return createReadableStream(scope, stream, {
    serialize: (frame: TokenFrame<string>) => {
      const json = JSON.stringify(frame) + '\n'
      return encoder.encode(json)
    },
  })
}
