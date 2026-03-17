/**
 * @sweatpants/stream-bridge
 *
 * Bridge Effection streams to HTTP responses with pull-based semantics.
 *
 * This package provides a clean way to convert Effection Stream<T> values
 * into Web ReadableStreams that can be used as HTTP Response bodies.
 *
 * Key features:
 * - Pull-based: values are only produced when the consumer requests them
 * - Backpressure: slow consumers don't cause unbounded buffering
 * - Efficient: minimal scope.run() overhead per item
 *
 * @example
 * ```typescript
 * import { createStreamResponse } from '@sweatpants/stream-bridge'
 * import { resource } from 'effection'
 *
 * // Create an Effection stream
 * const myStream = resource(function* (provide) {
 *   yield* provide({
 *     *next() {
 *       return { done: false, value: 'hello' }
 *     }
 *   })
 * })
 *
 * // Convert to HTTP Response
 * const response = yield* createStreamResponse(myStream, {
 *   serialize: (value) => new TextEncoder().encode(value + '\n')
 * })
 * ```
 */

export { createStreamResponse, createReadableStream, type StreamResponseOptions, type StreamResponseResult } from './stream-response.ts'
export {
  nodeRequestToWebRequest,
  sendWebResponse,
  type FetchHandler,
} from './node-fetch-adapter.ts'
