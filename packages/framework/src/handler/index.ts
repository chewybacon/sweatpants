/**
 * Chat Handler
 *
 * A portable fetch handler for AI chat that can be plugged into any framework.
 * 
 * The default `createChatHandler` is now the **durable chat handler** which provides:
 * - Session reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 * - Durable streaming with NDJSON + LSN format
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

// Re-export the durable handler as the main createChatHandler
export { createDurableChatHandler, createChatHandler } from './durable'

// Legacy handler - deprecated, will be removed in future version
export { createChatHandler as createLegacyChatHandler } from './create-handler'

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
export type {
  ChatHandlerConfig,
  ChatRequestBody,
  InitializerContext,
  ChatProvider,
  ChatMessage,
  ChatProviderEvent,
  ChatProviderResult,
  IsomorphicTool,
  ToolSchema,
  StreamEvent,
  ServerToolContext,
  ServerAuthorityContext,
  ResolvedPersona,
  PersonaResolver,
} from './types'

// Re-export durable-specific types
export type {
  DurableChatHandlerConfig,
  DurableStreamEvent,
  DurableStreamParams,
} from './durable'


