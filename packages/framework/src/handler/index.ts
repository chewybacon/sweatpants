/**
 * Chat Handler
 *
 * A portable fetch handler for AI chat that can be plugged into any framework.
 *
 * @example TanStack Start
 * ```ts
 * import { createChatHandler } from '@tanstack/framework/handler'
 * import { toolList } from './__generated__/tool-registry.gen'
 *
 * const handler = createChatHandler({
 *   tools: toolList,
 *   provider: myProvider,
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
 * const handler = createChatHandler({ tools, provider })
 * export const POST = handler
 * ```
 *
 * @example Hono
 * ```ts
 * import { createChatHandler } from '@tanstack/framework/handler'
 *
 * const handler = createChatHandler({ tools, provider })
 * app.post('/api/chat', (c) => handler(c.req.raw))
 * ```
 *
 * @packageDocumentation
 */

export { createChatHandler } from './create-handler'
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


