import { PROTOCOL_VERSION, type RuntimeRequest, type RuntimeResponse } from '../src/protocol.ts'
import { registry } from '../src/runtime-session-registry.ts'

async function invoke(request: RuntimeRequest): Promise<RuntimeResponse[]> {
  return await registry.handle(request, { runtimeSessionId: 'book-flight-local-smoke-runtime-session' })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function eventTypes(responses: RuntimeResponse[]): string[] {
  return responses.map((response) => response.type === 'tool_event' ? response.event.type : response.type)
}

async function main(): Promise<void> {
  const toolSessionId = 'book-flight-local-smoke'

  const start = await invoke({
    op: 'start_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'book-start',
    toolSessionId,
    toolName: 'book_flight',
    params: { from: 'NYC', destination: 'LAX' },
  })
  const pickFlight = start.find((response) => response.type === 'tool_event' && response.event.type === 'elicit_request' && response.event.key === 'pickFlight')
  assert(pickFlight?.type === 'tool_event' && pickFlight.event.type === 'elicit_request', 'missing pickFlight elicit')

  const afterFlight = await invoke({
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'book-pick-flight',
    toolSessionId,
    elicitId: pickFlight.event.elicitId,
    response: { action: 'accept', content: { flightId: 'FL001' } },
  })
  const pickSeat = afterFlight.find((response) => response.type === 'tool_event' && response.event.type === 'elicit_request' && response.event.key === 'pickSeat')
  assert(pickSeat?.type === 'tool_event' && pickSeat.event.type === 'elicit_request', 'missing pickSeat elicit')

  const afterSeat = await invoke({
    op: 'respond_to_elicit',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'book-pick-seat',
    toolSessionId,
    elicitId: pickSeat.event.elicitId,
    response: { action: 'accept', content: { row: 3, seat: 'A' } },
  })
  const sample = afterSeat.find((response) => response.type === 'tool_event' && response.event.type === 'sample_request')
  assert(sample?.type === 'tool_event' && sample.event.type === 'sample_request', 'missing sample request')

  const afterSample = await invoke({
    op: 'respond_to_sample',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'book-sample',
    toolSessionId,
    sampleId: sample.event.sampleId,
    response: { text: 'Use the rideshare pickup zone on the arrivals level.' },
  })
  const result = afterSample.find((response) => response.type === 'tool_event' && response.event.type === 'result')
  assert(result?.type === 'tool_event' && result.event.type === 'result', 'missing final result')

  const final = result.event.result as { success?: boolean; seat?: string; travelTip?: string }
  assert(final.success === true, 'booking did not succeed')
  assert(final.seat === '3A', `expected seat 3A, got ${final.seat}`)
  assert(final.travelTip === 'Use the rideshare pickup zone on the arrivals level.', 'travel tip mismatch')

  console.log(JSON.stringify({
    status: 'ok',
    startTypes: eventTypes(start),
    afterFlightTypes: eventTypes(afterFlight),
    afterSeatTypes: eventTypes(afterSeat),
    afterSampleTypes: eventTypes(afterSample),
    result: final,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
