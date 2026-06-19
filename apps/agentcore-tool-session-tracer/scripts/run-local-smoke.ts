import { PROTOCOL_VERSION, type RuntimeRequest, type RuntimeResponse } from '../src/protocol.ts'
import { registry } from '../src/runtime-session-registry.ts'

async function invoke(request: RuntimeRequest): Promise<RuntimeResponse[]> {
  return await registry.handle(request)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  const toolSessionId = 'local-smoke-tool-session'

  const start = await invoke({
    op: 'start_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-start',
    toolSessionId,
    toolName: 'elicit_then_result',
    params: { value: 1 },
  })

  assert(start.some((event) => event.type === 'tool_event' && event.event.type === 'elicit_request'), 'start did not emit elicit_request')
  const elicitEvent = start.find((event) => event.type === 'tool_event' && event.event.type === 'elicit_request')
  assert(elicitEvent?.type === 'tool_event' && elicitEvent.event.type === 'elicit_request', 'missing elicit event')

  const inspect = await invoke({
    op: 'inspect_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-inspect',
    toolSessionId,
  })
  assert(inspect.some((event) => event.type === 'session_status' && event.status === 'awaiting_elicit'), 'inspect did not observe awaiting_elicit')

  await new Promise((resolve) => setTimeout(resolve, 50))

  const wrong = await invoke({
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-wrong-elicit',
    toolSessionId,
    elicitId: 'wrong',
    response: { action: 'accept', content: { confirmed: false } },
  })
  assert(wrong.some((event) => event.type === 'command_conflict'), 'wrong elicit id did not conflict')

  const respond = await invoke({
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-respond',
    toolSessionId,
    elicitId: elicitEvent.event.elicitId,
    response: { action: 'accept', content: { confirmed: true } },
  })
  assert(respond.some((event) => event.type === 'tool_event' && event.event.type === 'result'), 'respond did not emit result')

  const duplicate = await invoke({
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-respond',
    toolSessionId,
    elicitId: elicitEvent.event.elicitId,
    response: { action: 'accept', content: { confirmed: true } },
  })
  assert(duplicate.some((event) => event.type === 'command_duplicate'), 'duplicate command was not idempotent')

  const missing = await invoke({
    op: 'inspect_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-missing',
    toolSessionId: 'missing-session',
  })
  assert(missing.some((event) => event.type === 'session_not_found'), 'missing session was not reported')

  const drain = await invoke({
    op: 'drain_tool_session_events',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-drain',
    toolSessionId,
    afterRuntimeEventSeq: 1,
  })
  assert(drain.some((event) => event.type === 'tool_event' && event.event.type === 'result'), 'drain did not replay result after seq 1')

  console.log(JSON.stringify({
    status: 'ok',
    startTypes: start.map((event) => event.type === 'tool_event' ? event.event.type : event.type),
    respondTypes: respond.map((event) => event.type === 'tool_event' ? event.event.type : event.type),
    duplicateTypes: duplicate.map((event) => event.type),
    drainTypes: drain.map((event) => event.type === 'tool_event' ? event.event.type : event.type),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
