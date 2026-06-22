import { call, createScope, suspend, useAbortSignal, useScope, type Operation, type Scope } from 'effection'
import type { FetchHandler, ScopedFetchHandler } from '../handler/streaming.ts'

export interface ChatApplicationSetupContext {
  signal: AbortSignal
}

export interface ChatApplication {
  handle(request: Request): Promise<Response>
  close(): Promise<void>
}

export interface ChatApplicationConfig {
  handler: FetchHandler
  setup?: (ctx: ChatApplicationSetupContext) => Operation<void>
}

let closedApplicationErrorMessage = 'ChatApplication is closed'

function isScopedFetchHandler(handler: FetchHandler): handler is ScopedFetchHandler {
  return typeof (handler as { withScope?: unknown }).withScope === 'function'
}

function isHaltedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'halted'
}

export function createChatApplication(config: ChatApplicationConfig): ChatApplication {
  const baseHandler = config.handler
  const [rootScope, destroyRootScope] = createScope()

  let closed = false
  let setupPromise: Promise<Scope> | undefined
  let scopedHandler: FetchHandler | undefined

  function ensureSetup(): Promise<Scope> {
    if (!setupPromise) {
      setupPromise = new Promise<Scope>((resolve, reject) => {
        let settled = false
        rootScope.run(function* () {
          try {
            const signal = yield* useAbortSignal()
            if (config.setup) {
              yield* config.setup({ signal })
            }
            const scope = yield* useScope()
            settled = true
            resolve(scope)
            yield* suspend()
          } catch (error) {
            if (!settled) {
              settled = true
              reject(error)
              return
            }
            if (!isHaltedError(error)) {
              throw error
            }
          }
        }).catch((error) => {
          if (!settled) {
            settled = true
            reject(error)
          }
        })
      })
    }
    return setupPromise
  }

  return {
    async handle(request: Request): Promise<Response> {
      if (closed) throw new Error(closedApplicationErrorMessage)
      try {
        const scope = await ensureSetup()
        if (closed) throw new Error(closedApplicationErrorMessage)
        if (!scopedHandler) {
          scopedHandler = isScopedFetchHandler(baseHandler)
            ? baseHandler.withScope(scope)
            : (nextRequest) => scope.run(function* () {
                return yield* call(() => baseHandler(nextRequest))
              })
        }
        return scopedHandler(request)
      } catch (error) {
        if (closed || error instanceof Error && error.message === closedApplicationErrorMessage) {
          throw new Error(closedApplicationErrorMessage)
        }
        console.error('[ChatApplication] setup failed', error)
        return new Response(JSON.stringify({ type: 'error', message: 'Chat application setup failed' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await destroyRootScope()
      scopedHandler = undefined
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
  ChatHandlerSetupContext,
  ChatHandlerSetup,
  ChatRequestBody,
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
