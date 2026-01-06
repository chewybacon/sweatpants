/**
 * Chat Handler
 *
 * A portable fetch handler for AI chat that can be plugged into any framework.
 * 
 * `createChatHandler` provides durable streaming with:
 * - Session reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 * - NDJSON streaming with `{ lsn, event }` format
 *
 * @example TanStack Start
 * ```ts
 * import { createChatHandler } from '@tanstack/framework/handler'
 * import { setupInMemoryDurableStreams } from '@tanstack/framework/chat/durable-streams'
 * import { toolList } from './__generated__/tool-registry.gen'
 *
 * const setupDurableStreams = function*() {
 *   yield* setupInMemoryDurableStreams()
 * }
 *
 * const handler = createChatHandler({
 *   initializerHooks: [setupDurableStreams, setupProvider, setupTools],
 * })
 *
 * export const Route = createAPIFileRoute('/api/chat')({
 *   POST: handler,
 * })
 * ```
 *
 * @example Next.js
 * ```ts
 * import { createChatHandler } from '@tanstack/framework/handler'
 *
 * const handler = createChatHandler({ initializerHooks: [...] })
 * export const POST = handler
 * ```
 *
 * @packageDocumentation
 */

// Export the durable handler as createChatHandler
export { createDurableChatHandler, createChatHandler } from './durable'

export {
  createStreamingHandler,
  useHandlerContext,
  HandlerContext,
} from './streaming'
export type {
  HandlerContext as HandlerContextValue,
  StreamingHandlerOptions,
  SetupResult,
  SetupFn,
} from './streaming'

// Export types from durable handler (the only handler now)
export type {
  DurableChatHandlerConfig as ChatHandlerConfig,
  ChatRequestBody,
  InitializerContext,
  InitializerHook,
  DurableStreamEvent,
  DurableStreamParams,
  IsomorphicTool,
  ToolSchema,
} from './durable'

// Export common types from base types file
export type {
  ChatProvider,
  ChatProviderEvent,
  ChatProviderResult,
  ChatMessage,
  StreamEvent,
  ServerToolContext,
  ServerAuthorityContext,
  ResolvedPersona,
  PersonaResolver,
} from './types'


