/**
 * Stream Bridge Experiments
 *
 * This package explores different approaches to bridging Effection streams
 * to HTTP response bodies. The goal is to find the cleanest, most efficient
 * approach that maintains pull-based semantics.
 *
 * Approaches:
 * 1. readable-stream-bridge - Current baseline (ReadableStream with scope.run in pull)
 * 2. async-iterable-response - Use AsyncIterable as Response body directly
 * 3. scope-captured-stream - Pre-capture subscription, minimize scope.run calls
 * 4. effection-server - Full Effection-native server with Operation<Response>
 */

export { createReadableStreamBridge } from './approaches/readable-stream-bridge.ts'
export { createAsyncIterableResponse } from './approaches/async-iterable-response.ts'
export { createScopeCapturedStream } from './approaches/scope-captured-stream.ts'
export { createEffectionServer, type EffectionServerOptions, type EffectionHandler } from './approaches/effection-server.ts'

export { createCountingGenerator, type CountingGeneratorOptions } from './test-utils.ts'
