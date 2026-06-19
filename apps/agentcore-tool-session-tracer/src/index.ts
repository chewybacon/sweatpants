import { BedrockAgentCoreApp, type RequestContext } from 'bedrock-agentcore/runtime'
import { z } from 'zod'
import { parseRuntimeRequest, type RuntimeResponse } from './protocol.ts'
import { registry } from './runtime-session-registry.ts'
import { initializeTelemetry, setSpanAttributes, withSpan } from './telemetry.ts'
import {
  flushCloudWatchLogs,
  log,
  logRequestComplete,
  logRequestError,
  logRequestStart,
  summarizeRequest,
  summarizeResponse,
} from './observability.ts'

async function handlePayload(payload: unknown, runtimeSessionId: string): Promise<{ responses: RuntimeResponse[]; requestSummary: Record<string, unknown> }> {
  const parsed = parseRuntimeRequest(payload)
  const requestSummary = summarizeRequest(parsed)
  // Use AgentCore's trusted invocation context session ID for ownership. Any
  // caller-provided payload field is intentionally ignored for runtime isolation.
  const responses = await registry.handle(parsed, { runtimeSessionId })
  return { responses, requestSummary }
}

export function createApp(): BedrockAgentCoreApp {
  return new BedrockAgentCoreApp({
    pingHandler: () => registry.isBusy() ? 'HealthyBusy' : 'Healthy',
    invocationHandler: {
      requestSchema: z.unknown(),
      process: async function* (payload: unknown, context: RequestContext) {
        const baseFields = {
          agentCoreRequestId: context.requestId,
          runtimeSessionId: context.sessionId,
        }
        const startedAt = logRequestStart(baseFields)

        try {
          const { responses, requestSummary } = await withSpan('agentcore.invoke', {
            'agentcore.request.id': context.requestId ?? '',
            'agentcore.runtime_session.id': context.sessionId,
          }, async (span) => {
            const handled = await handlePayload(payload, context.sessionId)
            span.setAttributes({
              ...otelSafeAttributes(handled.requestSummary, 'agentcore.request'),
              'agentcore.response.count': handled.responses.length,
            })
            return handled
          })
          const fields = { ...baseFields, ...requestSummary, responseCount: responses.length }
          setSpanAttributes({
            ...otelSafeAttributes(requestSummary, 'agentcore.request'),
            'agentcore.response.count': responses.length,
          })

          for (const response of responses) {
            log('info', 'agentcore.response.emit', { ...fields, ...summarizeResponse(response) })
            yield JSON.stringify({ event: response.type, data: response })
          }

          logRequestComplete(startedAt, fields)
          await flushCloudWatchLogs()
        } catch (error) {
          logRequestError(startedAt, error, baseFields)
          await flushCloudWatchLogs().catch(() => undefined)
          yield JSON.stringify({
            event: 'protocol_error',
            data: {
              type: 'protocol_error',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      },
    },
    config: {
      logging: {
        options: {
          level: process.env['AGENTCORE_FASTIFY_LOG_LEVEL'] ?? 'info',
        },
        disableRequestLogging: (request) => request.url === '/ping',
      },
    },
  })
}

function otelSafeAttributes(fields: Record<string, unknown>, prefix: string): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[`${prefix}.${key}`] = value
    }
  }
  return attrs
}

export async function main(): Promise<void> {
  initializeTelemetry()
  log('info', 'agentcore.runtime.boot', {
    port: Number(process.env['PORT'] ?? '8080'),
    nodeEnv: process.env['NODE_ENV'],
    logLevel: process.env['AGENTCORE_OBSERVABILITY_LOG_LEVEL'] ?? 'info',
    includePayloads: process.env['AGENTCORE_OBSERVABILITY_INCLUDE_PAYLOADS'] === 'yes',
  })
  createApp().run({ port: Number(process.env['PORT'] ?? '8080'), host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
