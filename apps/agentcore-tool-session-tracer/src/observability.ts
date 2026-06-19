import crypto from 'node:crypto'
import os from 'node:os'
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  type InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs'
import type { RuntimeEvent, RuntimeRequest, RuntimeResponse } from './protocol.ts'

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<ObservabilityLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const configuredLevel = (process.env['AGENTCORE_OBSERVABILITY_LOG_LEVEL'] ?? 'info').toLowerCase() as ObservabilityLevel
const minLevel = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info
const includePayloads = process.env['AGENTCORE_OBSERVABILITY_INCLUDE_PAYLOADS'] === 'yes'
const cloudWatchLogGroup = process.env['AGENTCORE_CLOUDWATCH_LOG_GROUP']
const cloudWatchLogStream = process.env['AGENTCORE_CLOUDWATCH_LOG_STREAM']
  ?? `runtime/${process.env['AWS_LAMBDA_LOG_STREAM_NAME'] ?? `${os.hostname()}/${process.pid}`}`
const cloudWatchClient = cloudWatchLogGroup
  ? new CloudWatchLogsClient({ region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1' })
  : undefined
let cloudWatchReady: Promise<void> | undefined
let cloudWatchWriteChain: Promise<void> = Promise.resolve()

export interface LogFields {
  [key: string]: unknown
}

function shouldLog(level: ObservabilityLevel): boolean {
  return LEVEL_ORDER[level] >= minLevel
}

function stableHash(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}

function durationMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function ensureCloudWatchStream(): Promise<void> {
  if (!cloudWatchClient || !cloudWatchLogGroup) return Promise.resolve()
  if (!cloudWatchReady) {
    cloudWatchReady = cloudWatchClient.send(new CreateLogStreamCommand({
      logGroupName: cloudWatchLogGroup,
      logStreamName: cloudWatchLogStream,
    })).then(
      () => undefined,
      (error: unknown) => {
        const name = (error as { name?: string }).name
        if (name === 'ResourceAlreadyExistsException') return undefined
        throw error
      }
    )
  }
  return cloudWatchReady
}

function writeCloudWatch(line: string): void {
  if (!cloudWatchClient || !cloudWatchLogGroup) return
  const logEvent: InputLogEvent = { timestamp: Date.now(), message: line }
  cloudWatchWriteChain = cloudWatchWriteChain
    .then(() => ensureCloudWatchStream())
    .then(() => cloudWatchClient.send(new PutLogEventsCommand({
      logGroupName: cloudWatchLogGroup,
      logStreamName: cloudWatchLogStream,
      logEvents: [logEvent],
    })))
    .then(
      () => undefined,
      (error: unknown) => {
        // Keep stdout logging as the reliable baseline. Avoid recursive log()
        // here because this function is called by log().
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'sweatpants-agentcore-tool-session-runtime',
          event: 'agentcore.cloudwatch_log_write_failed',
          logGroupName: cloudWatchLogGroup,
          logStreamName: cloudWatchLogStream,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }))
      }
    )
}

export function log(level: ObservabilityLevel, event: string, fields: LogFields = {}): void {
  if (!shouldLog(level)) return
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: 'sweatpants-agentcore-tool-session-runtime',
    event,
    ...fields,
  }
  const line = JSON.stringify(record)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  writeCloudWatch(line)
}

export async function flushCloudWatchLogs(): Promise<void> {
  await cloudWatchWriteChain
}

export function summarizeRequest(request: RuntimeRequest): LogFields {
  const base: LogFields = {
    protocolVersion: request.protocolVersion,
    op: request.op,
    commandId: request.commandId,
    toolSessionId: request.toolSessionId,
  }

  if ('toolName' in request) base['toolName'] = request.toolName
  if ('context' in request && request.context) {
    base['conversationId'] = request.context.conversationId
    base['callId'] = request.context.callId
    base['parentMessageCount'] = request.context.parentMessages?.length ?? 0
    base['hasSystemPrompt'] = request.context.systemPrompt !== undefined
  }
  if ('params' in request) {
    base['paramsHash'] = stableHash(request.params)
    if (includePayloads) base['params'] = request.params
  }
  if ('elicitId' in request) base['elicitId'] = request.elicitId
  if ('sampleId' in request) base['sampleId'] = request.sampleId
  if ('response' in request) {
    base['responseHash'] = stableHash(request.response)
    if (includePayloads) base['response'] = request.response
  }
  if ('afterRuntimeEventSeq' in request) base['afterRuntimeEventSeq'] = request.afterRuntimeEventSeq
  if ('reason' in request) base['reason'] = request.reason

  return base
}

export function summarizeEvent(event: RuntimeEvent): LogFields {
  switch (event.type) {
    case 'progress':
      return { runtimeEventType: event.type, message: event.message, progress: event.progress }
    case 'log':
      return { runtimeEventType: event.type, toolLogLevel: event.level, message: event.message }
    case 'elicit_request':
      return {
        runtimeEventType: event.type,
        elicitId: event.elicitId,
        elicitKey: event.key,
        message: event.message,
        schemaHash: stableHash(event.schema),
        hasContext: event.context !== undefined,
        ...(includePayloads ? { schema: event.schema, context: event.context } : {}),
      }
    case 'sample_request':
      return {
        runtimeEventType: event.type,
        sampleId: event.sampleId,
        messageCount: event.messages.length,
        hasSystemPrompt: event.systemPrompt !== undefined,
        maxTokens: event.maxTokens,
        toolCount: Array.isArray(event.tools) ? event.tools.length : 0,
        hasSchema: event.schema !== undefined,
        ...(includePayloads ? { messages: event.messages, tools: event.tools, schema: event.schema } : {}),
      }
    case 'result':
      return {
        runtimeEventType: event.type,
        resultHash: stableHash(event.result),
        ...(includePayloads ? { result: event.result } : {}),
      }
    case 'error':
      return {
        runtimeEventType: event.type,
        errorName: event.name,
        errorMessage: event.message,
        ...(includePayloads ? { stack: event.stack } : {}),
      }
    case 'cancelled':
      return { runtimeEventType: event.type, reason: event.reason }
  }
}

export function summarizeResponse(response: RuntimeResponse): LogFields {
  const base: LogFields = { responseType: response.type }
  if ('toolSessionId' in response) base['toolSessionId'] = response.toolSessionId
  if ('commandId' in response) base['commandId'] = response.commandId
  if (response.type === 'tool_event') {
    base['runtimeEventSeq'] = response.runtimeEventSeq
    base['runtimeEventId'] = response.runtimeEventId
    Object.assign(base, summarizeEvent(response.event))
  } else if (response.type === 'session_status') {
    base['status'] = response.status
    base['lastRuntimeEventSeq'] = response.lastRuntimeEventSeq
    base['pendingRequestType'] = response.pendingRequest?.type
  } else if (response.type === 'protocol_error') {
    base['errorMessage'] = response.message
    if (includePayloads) base['details'] = response.details
  } else if ('message' in response) {
    base['message'] = response.message
  }
  return base
}

export function logRequestStart(fields: LogFields): number {
  const startedAt = Date.now()
  log('info', 'agentcore.invoke.start', fields)
  return startedAt
}

export function logRequestComplete(startedAt: number, fields: LogFields): void {
  log('info', 'agentcore.invoke.complete', { ...fields, durationMs: durationMs(startedAt) })
}

export function logRequestError(startedAt: number, error: unknown, fields: LogFields): void {
  log('error', 'agentcore.invoke.error', {
    ...fields,
    durationMs: durationMs(startedAt),
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(includePayloads && error instanceof Error ? { stack: error.stack } : {}),
  })
}
