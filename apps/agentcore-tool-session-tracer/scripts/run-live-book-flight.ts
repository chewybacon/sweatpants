import crypto from 'node:crypto'
import { call, run } from 'effection'
import {
  createAwsSdkAgentCoreInvoker,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-aws-invoker.ts'
import {
  createAgentCoreRemoteToolRuntimeClient,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-runtime-client.ts'
import {
  createAgentCoreToolSessionRegistry,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-session-registry.ts'
import {
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-memory-store.ts'
import type {
  AgentCoreToolEvent,
  AgentCoreToolRuntimeProfile,
  AgentCoreToolSessionStores,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-types.ts'

if (process.env['APPROVE_AGENTCORE_PAID_INVOCATION'] !== 'yes') {
  console.error('Refusing live AgentCore book-flight smoke without APPROVE_AGENTCORE_PAID_INVOCATION=yes')
  process.exit(2)
}

const runtimeArnEnv = process.env['AGENTCORE_RUNTIME_ARN']
if (!runtimeArnEnv) throw new Error('AGENTCORE_RUNTIME_ARN is required')
const runtimeArn: string = runtimeArnEnv
const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const bookFlightTool = { name: 'book_flight' } as never

function latestElicit(events: Array<{ lsn: number; event: AgentCoreToolEvent }>, key: string): Extract<AgentCoreToolEvent, { type: 'elicit_request' }> | undefined {
  return [...events]
    .reverse()
    .map(({ event }) => event)
    .find((event): event is Extract<AgentCoreToolEvent, { type: 'elicit_request' }> => event.type === 'elicit_request' && event.key === key)
}

function latestSample(events: Array<{ lsn: number; event: AgentCoreToolEvent }>): Extract<AgentCoreToolEvent, { type: 'sample_request' }> | undefined {
  return [...events]
    .reverse()
    .map(({ event }) => event)
    .find((event): event is Extract<AgentCoreToolEvent, { type: 'sample_request' }> => event.type === 'sample_request')
}

async function main(): Promise<void> {
  const stores: AgentCoreToolSessionStores = {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  }
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(createAwsSdkAgentCoreInvoker({ clientConfig: { region } }))
  const profile: AgentCoreToolRuntimeProfile = {
    name: 'live-book-flight',
    runtimeArn,
    endpointName: process.env['AGENTCORE_QUALIFIER'] ?? 'DEFAULT',
    region,
    toolNames: ['book_flight'],
    maxSessionTtlMs: 15 * 60 * 1000,
  }
  const runtimeSessionId = process.env['AGENTCORE_SESSION_ID'] ?? `sp-book-flight-${crypto.randomUUID()}`
  const toolSessionId = process.env['TOOL_SESSION_ID'] ?? `book-flight-${crypto.randomUUID()}`

  const summary = await run(function* () {
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient,
      profiles: [profile],
      createRuntimeSessionId: () => runtimeSessionId,
    })

    const session = yield* registry.create(bookFlightTool, { from: 'NYC', destination: 'LAX' }, { sessionId: toolSessionId })
    assert((yield* session.status()) === 'awaiting_elicit', 'expected first awaiting_elicit')

    let events = (yield* stores.events.readAfter(toolSessionId, 0)).events
    const pickFlight = latestElicit(events, 'pickFlight')
    assert(pickFlight, 'missing pickFlight elicit')

    yield* call(() => new Promise((resolve) => setTimeout(resolve, Number(process.env['AGENTCORE_BOOK_FLIGHT_TURN_DELAY_MS'] ?? '1000'))))
    yield* session.respondToElicit(pickFlight.elicitId, { action: 'accept', content: { flightId: 'FL001' } })
    assert((yield* session.status()) === 'awaiting_elicit', 'expected second awaiting_elicit')

    events = (yield* stores.events.readAfter(toolSessionId, 0)).events
    const pickSeat = latestElicit(events, 'pickSeat')
    assert(pickSeat, 'missing pickSeat elicit')

    yield* call(() => new Promise((resolve) => setTimeout(resolve, Number(process.env['AGENTCORE_BOOK_FLIGHT_TURN_DELAY_MS'] ?? '1000'))))
    yield* session.respondToElicit(pickSeat.elicitId, { action: 'accept', content: { row: 3, seat: 'A' } })
    assert((yield* session.status()) === 'awaiting_sample', 'expected awaiting_sample')

    events = (yield* stores.events.readAfter(toolSessionId, 0)).events
    const sample = latestSample(events)
    assert(sample, 'missing sample request')

    yield* call(() => new Promise((resolve) => setTimeout(resolve, Number(process.env['AGENTCORE_BOOK_FLIGHT_TURN_DELAY_MS'] ?? '1000'))))
    yield* session.respondToSample(sample.sampleId, { text: 'Use the rideshare pickup zone on the arrivals level.' })
    assert((yield* session.status()) === 'completed', 'expected completed')

    events = (yield* stores.events.readAfter(toolSessionId, 0)).events
    const result = [...events].reverse().find(({ event }) => event.type === 'result')?.event
    assert(result?.type === 'result', 'missing final result')
    const booking = result.result as { success?: boolean; seat?: string; travelTip?: string; flight?: { id?: string }; ticketNumber?: string }
    assert(booking.success === true, 'booking did not succeed')
    assert(booking.flight?.id === 'FL001', 'flight mismatch')
    assert(booking.seat === '3A', 'seat mismatch')
    assert(booking.travelTip === 'Use the rideshare pickup zone on the arrivals level.', 'travel tip mismatch')

    const handle = yield* stores.handles.get(toolSessionId)
    return {
      status: 'ok',
      runtimeArn,
      region,
      runtimeSessionId,
      toolSessionId,
      handle,
      eventTypes: events.map(({ event }) => event.type),
      elicitKeys: events.flatMap(({ event }) => event.type === 'elicit_request' ? [event.key] : []),
      result: booking,
      events,
    }
  })

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
