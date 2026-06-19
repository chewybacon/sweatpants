import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { call, resource, type Operation, type Stream, type Subscription } from 'effection'
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  type BedrockAgentCoreClientConfig,
} from '@aws-sdk/client-bedrock-agentcore'
import type { AgentCoreToolRuntimeResponse } from './agentcore-types.ts'
import type { AgentCoreInvokeInput, AgentCoreInvoker } from './agentcore-runtime-client.ts'

export interface AwsSdkAgentCoreInvokerOptions {
  client?: BedrockAgentCoreClient
  clientConfig?: BedrockAgentCoreClientConfig
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function configuredInvokerLogLevel(): LogLevel {
  const value = process.env['AGENTCORE_INVOKER_LOG_LEVEL']?.toLowerCase()
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info'
}

function logInvoker(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[configuredInvokerLogLevel()]) return
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: 'sweatpants-agentcore-invoker',
    event,
    ...fields,
  }
  const line = JSON.stringify(record)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

async function bodyToString(body: unknown): Promise<string> {
  const value = body as {
    transformToString?: () => Promise<string>
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>
  } | undefined
  if (!value) return ''
  if (typeof value.transformToString === 'function') return await value.transformToString()
  if (typeof value[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    for await (const chunk of value as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

export function parseAgentCoreSseResponses(raw: string): AgentCoreToolRuntimeResponse[] {
  const responses: AgentCoreToolRuntimeResponse[] = []
  for (const block of raw.split(/\n\n+/)) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) continue
    let text = dataLines.join('\n')
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'string') {
        text = parsed.startsWith('data:') ? parsed.slice(5).trim() : parsed
      } else if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        responses.push((parsed as { data: AgentCoreToolRuntimeResponse }).data)
        continue
      }
    } catch {
      // Keep raw text and try below.
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        responses.push((parsed as { data: AgentCoreToolRuntimeResponse }).data)
      } else {
        responses.push(parsed as AgentCoreToolRuntimeResponse)
      }
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }
  return responses
}

export function streamFromAgentCoreToolRuntimeResponses(
  responses: AgentCoreToolRuntimeResponse[]
): Stream<AgentCoreToolRuntimeResponse, void> {
  return resource<Subscription<AgentCoreToolRuntimeResponse, void>>(function* (provide) {
    let index = 0
    yield* provide({
      *next(): Operation<IteratorResult<AgentCoreToolRuntimeResponse, void>> {
        if (index >= responses.length) return { done: true, value: undefined }
        return { done: false, value: responses[index++]! }
      },
    })
  })
}

export function createAwsSdkAgentCoreInvoker(
  options: AwsSdkAgentCoreInvokerOptions = {}
): AgentCoreInvoker {
  const client = options.client ?? new BedrockAgentCoreClient(options.clientConfig ?? {})

  return {
    *invoke(input: AgentCoreInvokeInput): Operation<Stream<AgentCoreToolRuntimeResponse, void>> {
      const startedAt = Date.now()
      logInvoker('info', 'agentcore.invoke.start', {
        runtimeArn: input.runtimeArn,
        endpointName: input.endpointName,
        runtimeSessionId: input.runtimeSessionId,
        op: input.payload.op,
        commandId: input.payload.commandId,
        toolSessionId: input.payload.toolSessionId,
        toolName: 'toolName' in input.payload ? input.payload.toolName : undefined,
      })
      try {
        const response = yield* call(() => client.send(new InvokeAgentRuntimeCommand({
          agentRuntimeArn: input.runtimeArn,
          qualifier: input.endpointName,
          runtimeSessionId: input.runtimeSessionId,
          payload: Buffer.from(JSON.stringify(input.payload)),
          contentType: 'application/json',
          accept: 'text/event-stream',
        })))
        const raw = yield* call(() => bodyToString(response.response))
        const parsed = parseAgentCoreSseResponses(raw)
        logInvoker('info', 'agentcore.invoke.complete', {
          runtimeArn: input.runtimeArn,
          endpointName: input.endpointName,
          runtimeSessionId: input.runtimeSessionId,
          op: input.payload.op,
          commandId: input.payload.commandId,
          toolSessionId: input.payload.toolSessionId,
          responseCount: parsed.length,
          httpStatusCode: response.$metadata.httpStatusCode,
          requestId: response.$metadata.requestId,
          durationMs: Date.now() - startedAt,
        })
        return streamFromAgentCoreToolRuntimeResponses(parsed)
      } catch (error) {
        logInvoker('error', 'agentcore.invoke.error', {
          runtimeArn: input.runtimeArn,
          endpointName: input.endpointName,
          runtimeSessionId: input.runtimeSessionId,
          op: input.payload.op,
          commandId: input.payload.commandId,
          toolSessionId: input.payload.toolSessionId,
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },

    *stopRuntimeSession(input: Omit<AgentCoreInvokeInput, 'payload'>): Operation<void> {
      const startedAt = Date.now()
      logInvoker('info', 'agentcore.stop_runtime_session.start', {
        runtimeArn: input.runtimeArn,
        endpointName: input.endpointName,
        runtimeSessionId: input.runtimeSessionId,
      })
      yield* call(() => client.send(new StopRuntimeSessionCommand({
        agentRuntimeArn: input.runtimeArn,
        qualifier: input.endpointName,
        runtimeSessionId: input.runtimeSessionId,
        clientToken: randomUUID(),
      })))
      logInvoker('info', 'agentcore.stop_runtime_session.complete', {
        runtimeArn: input.runtimeArn,
        endpointName: input.endpointName,
        runtimeSessionId: input.runtimeSessionId,
        durationMs: Date.now() - startedAt,
      })
    },
  }
}
