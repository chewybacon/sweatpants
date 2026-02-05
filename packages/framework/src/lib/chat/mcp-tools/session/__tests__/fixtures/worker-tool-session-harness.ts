import { run, spawn, sleep, each } from 'effection'
import type { Operation } from 'effection'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createWorkerToolSession } from '../../worker-tool-session.ts'
import type { ToolSession, ToolSessionEvent } from '../../types.ts'

const scenario = process.argv[2]
if (!scenario) {
  throw new Error('Scenario argument is required')
}

const workerPathCandidates = [
  resolve(
    process.cwd(),
    'src/lib/chat/mcp-tools/session/__tests__/fixtures/tool-worker.mjs'
  ),
  resolve(
    process.cwd(),
    'packages/framework/src/lib/chat/mcp-tools/session/__tests__/fixtures/tool-worker.mjs'
  ),
]

const workerPath = (() => {
  const candidate = workerPathCandidates.find((path) => existsSync(path))
  if (!candidate) {
    throw new Error('Failed to resolve tool-worker.mjs fixture path')
  }
  return candidate
})()

const workerUrl = pathToFileURL(workerPath)

function* collectEvents(
  session: ToolSession,
  events: ToolSessionEvent[],
  handler?: (event: ToolSessionEvent) => Operation<void>
) {
  yield* spawn(function* () {
    for (const event of yield* each(session.events())) {
      events.push(event)
      if (handler) {
        yield* handler(event)
      }
      yield* each.next()
    }
  })
}

function* waitForEvent(
  events: ToolSessionEvent[],
  type: ToolSessionEvent['type'],
  timeoutMs = 1000
): Operation<ToolSessionEvent | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const event = events.find((candidate) => candidate.type === type)
    if (event) {
      return event
    }
    yield* sleep(10)
  }
  return null
}

function* respondToEvent(session: ToolSession, event: ToolSessionEvent): Operation<void> {
  if (event.type === 'sample_request') {
    yield* sleep(25)
    yield* session.respondToSample(event.sampleId, {
      text: 'Hello, Alice!',
      model: 'test-model',
      stopReason: 'endTurn',
    })
  }

  if (event.type === 'elicit_request') {
    yield* sleep(25)
    yield* session.respondToElicit(event.elicitId, {
      action: 'accept',
      content: { confirmed: true },
    })
  }
}

function* respondToEventWithSampleSequence(
  session: ToolSession,
  event: ToolSessionEvent,
  getNextText: () => string
): Operation<void> {
  if (event.type === 'sample_request') {
    yield* sleep(25)
    yield* session.respondToSample(event.sampleId, {
      text: getNextText(),
      model: 'test-model',
      stopReason: 'endTurn',
    })
  }
}

function* respondToEventWithElicitDecline(
  session: ToolSession,
  event: ToolSessionEvent
): Operation<void> {
  if (event.type === 'elicit_request') {
    yield* sleep(25)
    yield* session.respondToElicit(event.elicitId, {
      action: 'decline',
    })
  }
}

function* respondToEventSampleThenElicit(
  session: ToolSession,
  event: ToolSessionEvent
): Operation<void> {
  if (event.type === 'sample_request') {
    yield* sleep(25)
    yield* session.respondToSample(event.sampleId, {
      text: 'Hello Alice!',
      model: 'test-model',
      stopReason: 'endTurn',
    })
  }

  if (event.type === 'elicit_request') {
    yield* sleep(25)
    yield* session.respondToElicit(event.elicitId, {
      action: 'accept',
      content: { approved: true, edited: false },
    })
  }
}

async function main() {
  const result = await run(function* () {
    const events: ToolSessionEvent[] = []

    if (scenario === 'echo') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'echo',
        params: { message: 'hello' },
        workerUrl,
      })

      yield* collectEvents(session, events)
      const resultEvent = yield* waitForEvent(events, 'result')

      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    if (scenario === 'missing') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'missing_tool',
        params: {},
        workerUrl,
      })

      yield* collectEvents(session, events)
      const errorEvent = yield* waitForEvent(events, 'error')

      const status = yield* session.status()

      return {
        status,
        error: errorEvent?.type === 'error' ? errorEvent.message : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    if (scenario === 'sample') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'greeter',
        params: { name: 'Alice' },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) => respondToEvent(session, event))
      
      // Wait for sample_request event to arrive before checking status
      yield* waitForEvent(events, 'sample_request')

      const statusBefore = yield* session.status()
      const resultEvent = yield* waitForEvent(events, 'result')
      const statusAfter = yield* session.status()

      return {
        statusBefore,
        statusAfter,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    if (scenario === 'elicit') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'confirmer',
        params: { action: 'delete files' },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) => respondToEvent(session, event))
      yield* sleep(10)

      const statusBefore = yield* session.status()
      const resultEvent = yield* waitForEvent(events, 'result')
      const statusAfter = yield* session.status()

      return {
        statusBefore,
        statusAfter,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    if (scenario === 'multi_sample') {
      let sampleCount = 0
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'multi_sample',
        params: { count: 3 },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) =>
        respondToEventWithSampleSequence(session, event, () => {
          sampleCount++
          return `Response ${sampleCount}`
        })
      )
      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    if (scenario === 'elicit_decline') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'confirmer',
        params: { action: 'format disk' },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) =>
        respondToEventWithElicitDecline(session, event)
      )
      const resultEvent = yield* waitForEvent(events, 'result')
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    if (scenario === 'sample_then_elicit') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'greet_with_confirm',
        params: { name: 'Alice', style: 'casual' },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) =>
        respondToEventSampleThenElicit(session, event)
      )
      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    throw new Error(`Unknown scenario: ${scenario}`)
  })

  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
