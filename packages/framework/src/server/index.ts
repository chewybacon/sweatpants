import { createChatHandler } from '../handler/durable/index.ts'
import type { DurableChatHandlerConfig } from '../handler/durable/types.ts'

type FetchHandler = (request: Request) => Response | Promise<Response>

export interface ChatApplication {
  handle(request: Request): Promise<Response>
  close(): Promise<void>
}

export interface ChatApplicationConfig {
  handler?: FetchHandler
  setup?: () => void | Promise<void>
}

let closedApplicationErrorMessage = 'ChatApplication is closed'

export function createChatApplication(config: ChatApplicationConfig & { handler: FetchHandler }): ChatApplication
export function createChatApplication(config: ChatApplicationConfig & DurableChatHandlerConfig): ChatApplication
export function createChatApplication(config: ChatApplicationConfig & Partial<DurableChatHandlerConfig> = {}): ChatApplication {
  const handler = config.handler ?? createChatHandler(config as DurableChatHandlerConfig)
  let closed = false
  let setupPromise: Promise<void> | undefined

  function ensureSetup(): Promise<void> {
    if (!setupPromise) {
      setupPromise = Promise.resolve().then(() => config.setup?.()).then(() => undefined)
    }
    return setupPromise
  }

  return {
    async handle(request: Request): Promise<Response> {
      if (closed) throw new Error(closedApplicationErrorMessage)
      try {
        await ensureSetup()
      } catch {
        return new Response(JSON.stringify({ type: 'error', message: 'Chat application setup failed' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (closed) throw new Error(closedApplicationErrorMessage)
      return handler(request)
    },
    async close(): Promise<void> {
      closed = true
    },
  }
}

export {
  createChatHandler,
  createDurableChatHandler,
  createChatEngine,
  createPluginSessionManager,
} from '../handler/durable/index.ts'

export {
  createStreamingHandler,
  useHandlerContext,
  HandlerContext,
} from '../handler/streaming.ts'

export type {
  DurableChatHandlerConfig as ChatHandlerConfig,
  ChatRequestBody,
  InitializerContext,
  InitializerHook,
  DurableStreamEvent,
  DurableStreamParams,
  IsomorphicTool,
  ToolSchema,
  McpToolRegistry,
  PluginSessionManager,
  PluginSession,
  PluginSessionStatus,
  PluginSessionEvent,
  PluginSessionInfo,
  PluginSessionManagerOptions,
  CreatePluginSessionConfig,
} from '../handler/durable/index.ts'

export type {
  HandlerContext as HandlerContextValue,
  StreamingHandlerOptions,
  SetupResult,
  SetupFn,
} from '../handler/streaming.ts'
