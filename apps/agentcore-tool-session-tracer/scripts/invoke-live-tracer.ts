import { writeFile } from 'node:fs/promises'
import crypto from 'node:crypto'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { PROTOCOL_VERSION, type RuntimeRequest, type RuntimeResponse } from '../src/protocol.ts'

if (process.env['APPROVE_AGENTCORE_PAID_INVOCATION'] !== 'yes') {
  console.error('Refusing live AgentCore tracer without APPROVE_AGENTCORE_PAID_INVOCATION=yes')
  process.exit(2)
}

const runtimeArn = process.env['AGENTCORE_RUNTIME_ARN']
if (!runtimeArn) throw new Error('AGENTCORE_RUNTIME_ARN is required')

const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'
const client = new BedrockAgentCoreClient({ region })

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

function parseSse(raw: string): RuntimeResponse[] {
  const responses: RuntimeResponse[] = []
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
        responses.push((parsed as { data: RuntimeResponse }).data)
        continue
      }
    } catch {
      // keep raw text
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && 'data' in parsed) responses.push((parsed as { data: RuntimeResponse }).data)
      else responses.push(parsed as RuntimeResponse)
    } catch {
      // ignore non-json data lines
    }
  }
  return responses
}

async function invoke(runtimeSessionId: string, payload: RuntimeRequest): Promise<{ raw: string; responses: RuntimeResponse[] }> {
  const response = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    qualifier: process.env['AGENTCORE_QUALIFIER'] ?? 'DEFAULT',
    runtimeSessionId,
    payload: Buffer.from(JSON.stringify(payload)),
    contentType: 'application/json',
    accept: 'text/event-stream',
  }))
  const raw = await bodyToString(response.response)
  return { raw, responses: parseSse(raw) }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  const runtimeSessionId = process.env['AGENTCORE_SESSION_ID'] ?? `sp-tool-tracer-${crypto.randomUUID()}`
  const wrongRuntimeSessionId = `${runtimeSessionId}-wrong`
  const toolSessionId = process.env['TOOL_SESSION_ID'] ?? `tool-${crypto.randomUUID()}`

  const start = await invoke(runtimeSessionId, {
    op: 'start_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-start',
    toolSessionId,
    toolName: 'elicit_then_result',
    params: { tracer: true },
  })
  const elicit = start.responses.find((response) => response.type === 'tool_event' && response.event.type === 'elicit_request')
  assert(elicit?.type === 'tool_event' && elicit.event.type === 'elicit_request', 'start did not emit elicit_request')

  const delayMs = Number(process.env['AGENTCORE_TRACER_DELAY_MS'] ?? '60000')
  await new Promise((resolve) => setTimeout(resolve, delayMs))

  const inspect = await invoke(runtimeSessionId, {
    op: 'inspect_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-inspect',
    toolSessionId,
  })
  assert(inspect.responses.some((response) => response.type === 'session_status' && response.status === 'awaiting_elicit'), 'inspect did not observe awaiting_elicit')

  const wrongSession = await invoke(wrongRuntimeSessionId, {
    op: 'inspect_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-wrong-session',
    toolSessionId,
  })
  assert(wrongSession.responses.some((response) => response.type === 'session_not_found'), 'wrong runtimeSessionId did not return session_not_found')

  const wrongElicit = await invoke(runtimeSessionId, {
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-wrong-elicit',
    toolSessionId,
    elicitId: 'wrong',
    response: { action: 'accept', content: { confirmed: false } },
  })
  assert(wrongElicit.responses.some((response) => response.type === 'command_conflict'), 'wrong elicit did not return command_conflict')

  const respond = await invoke(runtimeSessionId, {
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-respond',
    toolSessionId,
    elicitId: elicit.event.elicitId,
    response: { action: 'accept', content: { confirmed: true } },
  })
  assert(respond.responses.some((response) => response.type === 'tool_event' && response.event.type === 'result'), 'respond did not emit result')

  const duplicate = await invoke(runtimeSessionId, {
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-respond',
    toolSessionId,
    elicitId: elicit.event.elicitId,
    response: { action: 'accept', content: { confirmed: true } },
  })
  assert(duplicate.responses.some((response) => response.type === 'command_duplicate'), 'duplicate command did not return command_duplicate')

  const drain = await invoke(runtimeSessionId, {
    op: 'drain_tool_session_events',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'live-drain',
    toolSessionId,
    afterRuntimeEventSeq: 1,
  })
  assert(drain.responses.some((response) => response.type === 'tool_event' && response.event.type === 'result'), 'drain did not replay result')

  const summary = {
    status: 'ok',
    runtimeArn,
    region,
    runtimeSessionId,
    wrongRuntimeSessionId,
    toolSessionId,
    delayMs,
    start: start.responses,
    inspect: inspect.responses,
    wrongSession: wrongSession.responses,
    wrongElicit: wrongElicit.responses,
    respond: respond.responses,
    duplicate: duplicate.responses,
    drain: drain.responses,
  }
  console.log(JSON.stringify(summary, null, 2))
  await writeFile(process.env['OUTPUT_FILE'] ?? 'agentcore-tool-session-live-tracer-output.json', JSON.stringify(summary, null, 2), 'utf8')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
