import { createContext, type Operation } from 'effection'
import { TransportContext, type CorrelatedTransport, type TransportRequest, type NotifyResponse } from '@sweatpants/core'
import type { ChatPatch } from '../patches/index.ts'

export interface FrameworkBridgeConfig {
  callId: string
  emitPatch: (patch: ChatPatch) => Operation<void>
}

export const FrameworkBridgeContext = createContext<FrameworkBridgeConfig>('framework-bridge')

function createFrameworkTransport(config: FrameworkBridgeConfig): CorrelatedTransport {
  return {
    request<TProgress, TResponse>(message: TransportRequest) {
      return {
        *[Symbol.iterator]() {
          if (message.kind === 'notify') {
            const payload = message.payload as { message?: string; progress?: number } | undefined
            yield* config.emitPatch({
              type: 'client_tool_progress',
              id: config.callId,
              message: payload?.message ?? String(message.payload ?? ''),
              ...(payload?.progress !== undefined ? { progress: payload.progress } : {}),
            })
            const response: NotifyResponse = { ok: true }
            return response as TResponse
          }
          throw new Error(`Unsupported transport request kind: ${message.kind}`)
        },
      } as unknown as import('effection').Stream<TProgress, TResponse>
    },
  }
}

export function* withFrameworkTransport<T>(
  callId: string,
  operation: () => Operation<T>
): Operation<T> {
  return yield* withFrameworkTransportAndEmitter(callId, function* () {}, operation)
}

export function* withFrameworkTransportAndEmitter<T>(
  callId: string,
  emitPatch: (patch: ChatPatch) => Operation<void>,
  operation: () => Operation<T>
): Operation<T> {
  const config: FrameworkBridgeConfig = { callId, emitPatch }
  const transport = createFrameworkTransport(config)
  return yield* FrameworkBridgeContext.with(config, function* () {
    return yield* TransportContext.with(transport, operation)
  })
}
