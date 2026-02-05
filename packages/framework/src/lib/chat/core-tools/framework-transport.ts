/**
 * Framework Transport for Core Tools
 *
 * Creates a CorrelatedTransport that bridges @sweatpants/core operations
 * (notify, elicit, sample) to the framework's patch-based streaming system.
 *
 * This allows core tools to use operations like `notify()` which get
 * converted to framework patches and streamed to the client.
 */
import { resource, createContext, type Operation, type Stream, type Subscription } from 'effection'
import {
  TransportContext,
  type CorrelatedTransport,
  type TransportRequest,
  type NotifyResponse,
} from '@sweatpants/core'
import type { ServerToolContext } from '../isomorphic-tools/types.ts'
import type { ClientToolProgressPatch } from '../patches/tool.ts'
import type { ChatPatch } from '../patches/index.ts'

/**
 * Context for the framework bridge.
 * Provides access to patch emission during core tool execution.
 */
export interface FrameworkBridgeConfig {
  /** The tool call ID for correlation */
  callId: string
  /** Function to emit patches to the client */
  emitPatch: (patch: ChatPatch) => Operation<void>
}

/**
 * Context that holds the framework bridge configuration.
 * Set during core tool execution to enable notify/elicit bridging.
 */
export const FrameworkBridgeContext = createContext<FrameworkBridgeConfig>('framework-bridge')

/**
 * Creates a CorrelatedTransport that bridges core operations to framework patches.
 *
 * Currently supported operations:
 * - `notify`: Emits `ClientToolProgressPatch` to the client
 *
 * Future operations (Phase 6):
 * - `elicit`: Will emit elicit patches and suspend for user response
 */
function createFrameworkTransport(config: FrameworkBridgeConfig): CorrelatedTransport {
  return {
    request<TProgress, TResponse>(
      message: TransportRequest
    ): Stream<TProgress, TResponse> {
      return resource(function* (provide) {
        if (message.kind === 'notify') {
          // Extract message and progress from payload
          const payload = message.payload as { message?: string; progress?: number } | undefined
          const progressMessage = payload?.message ?? String(message.payload ?? '')
          const progressPercent = payload?.progress

          // Emit progress patch to client
          const patch: ClientToolProgressPatch = {
            type: 'client_tool_progress',
            id: config.callId,
            message: progressMessage,
            ...(progressPercent !== undefined && { progress: progressPercent }),
          }

          yield* config.emitPatch(patch)

          // Create a subscription that immediately returns success
          const response: NotifyResponse = { ok: true }

          // Provide a subscription that completes immediately with the response
          const subscription: Subscription<TProgress, TResponse> = {
            *next() {
              return { done: true as const, value: response as TResponse }
            },
          }

          yield* provide(subscription)
          return
        }

        if (message.kind === 'elicit') {
          // Elicit requires suspension - will be implemented in Phase 6
          throw new Error(
            `Core tool elicit() not yet supported in framework bridge. ` +
            `Tool: ${message.type}, Request ID: ${message.id}`
          )
        }

        if (message.kind === 'sample') {
          // Sample requires LLM integration - will be implemented when framework
          // provides a unified LLM sampling API that core tools can use
          throw new Error(
            `Core tool sample() not yet supported in framework bridge. ` +
            `Use the framework's native sampling API instead. ` +
            `Request ID: ${message.id}`
          )
        }

        throw new Error(`Unknown transport request kind: ${message.kind}`)
      })
    },
  }
}

/**
 * Run an operation with FrameworkTransport in context.
 *
 * This sets up both:
 * 1. FrameworkBridgeContext - for internal configuration
 * 2. TransportContext - for core operations to use
 *
 * Core tools using `notify()` will have their calls routed through
 * this transport and converted to framework patches.
 *
 * @param ctx - The server tool context (provides callId)
 * @param operation - The operation to run (typically core tool execution)
 */
export function* withFrameworkTransport<T>(
  ctx: ServerToolContext,
  operation: () => Operation<T>
): Operation<T> {
  // For now, we use a no-op emitPatch since we don't have access to the patch channel.
  // The executor will need to set up the actual patch emission.
  // This is a placeholder that will be enhanced when integrating with the executor.
  const config: FrameworkBridgeConfig = {
    callId: ctx.callId,
    emitPatch: function* (_patch: ChatPatch): Operation<void> {
      // TODO: This needs to be wired up to the actual patch channel
      // For Phase 3, we'll need to pass the patch channel through context
      // or modify how the executor calls adapted tools
    },
  }

  const transport = createFrameworkTransport(config)

  return yield* FrameworkBridgeContext.with(config, function* () {
    return yield* TransportContext.with(transport, operation)
  })
}

/**
 * Run an operation with a fully configured FrameworkTransport.
 *
 * This is the complete version that accepts a patch emitter function.
 * Use this when you have access to the patch channel.
 *
 * @param callId - The tool call ID for correlation
 * @param emitPatch - Function to emit patches to the client
 * @param operation - The operation to run
 */
export function* withFrameworkTransportAndEmitter<T>(
  callId: string,
  emitPatch: (patch: ChatPatch) => Operation<void>,
  operation: () => Operation<T>
): Operation<T> {
  const config: FrameworkBridgeConfig = {
    callId,
    emitPatch,
  }

  const transport = createFrameworkTransport(config)

  return yield* FrameworkBridgeContext.with(config, function* () {
    return yield* TransportContext.with(transport, operation)
  })
}
