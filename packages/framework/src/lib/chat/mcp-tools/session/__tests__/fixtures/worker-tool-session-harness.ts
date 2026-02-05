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

function* respondToEventWithElicitCancel(
  session: ToolSession,
  event: ToolSessionEvent
): Operation<void> {
  if (event.type === 'elicit_request') {
    yield* sleep(25)
    yield* session.respondToElicit(event.elicitId, {
      action: 'cancel',
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

/**
 * Handler for book_flight scenario - mimics the real book_flight e2e flow.
 * Responds to:
 * 1. pickFlight elicit → { flightId: 'FL001' }
 * 2. pickSeat elicit → { row: 3, seat: 'A' }
 * 3. sample request → travel tip text
 */
function* respondToBookFlightEvents(
  session: ToolSession,
  event: ToolSessionEvent,
  state: { elicitCount: number }
): Operation<void> {
  if (event.type === 'elicit_request') {
    yield* sleep(25)
    state.elicitCount++
    
    if (event.key === 'pickFlight') {
      yield* session.respondToElicit(event.elicitId, {
        action: 'accept',
        content: { flightId: 'FL001' },
      })
    } else if (event.key === 'pickSeat') {
      yield* session.respondToElicit(event.elicitId, {
        action: 'accept',
        content: { row: 3, seat: 'A' },
      })
    } else {
      // Generic accept for any other elicit
      yield* session.respondToElicit(event.elicitId, {
        action: 'accept',
        content: {},
      })
    }
  }

  if (event.type === 'sample_request') {
    yield* sleep(25)
    yield* session.respondToSample(event.sampleId, {
      text: 'Remember to check the weather before you travel!',
      model: 'test-model',
      stopReason: 'endTurn',
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
      
      // Wait for elicit_request event to arrive before checking status
      yield* waitForEvent(events, 'elicit_request')

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

    if (scenario === 'elicit_cancel') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'confirmer',
        params: { action: 'delete all' },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) =>
        respondToEventWithElicitCancel(session, event)
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

    // =========================================================================
    // book_flight scenario - mimics the full e2e book_flight flow
    // Flow: elicit(pickFlight) → elicit(pickSeat) → sample() → result
    // =========================================================================
    if (scenario === 'book_flight') {
      const bookFlightState = { elicitCount: 0 }
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'book_flight',
        params: { from: 'NYC', destination: 'LAX' },
        workerUrl,
      })

      yield* collectEvents(session, events, (event) =>
        respondToBookFlightEvents(session, event, bookFlightState)
      )

      // Wait for first elicit (pickFlight)
      yield* waitForEvent(events, 'elicit_request', 2000)
      const statusAfterFirstElicit = yield* session.status()

      // Wait for result (which comes after all interactions complete)
      const resultEvent = yield* waitForEvent(events, 'result', 5000)
      const finalStatus = yield* session.status()

      // Count event types for verification
      const elicitRequests = events.filter((e) => e.type === 'elicit_request')
      const sampleRequests = events.filter((e) => e.type === 'sample_request')

      return {
        statusAfterFirstElicit,
        finalStatus,
        elicitCount: elicitRequests.length,
        sampleCount: sampleRequests.length,
        elicitKeys: elicitRequests.map((e) =>
          e.type === 'elicit_request' ? e.key : null
        ),
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // book_flight_decline_flight - user declines at first elicit
    // =========================================================================
    if (scenario === 'book_flight_decline_flight') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'book_flight',
        params: { from: 'NYC', destination: 'LAX' },
        workerUrl,
      })

      yield* collectEvents(session, events, function* (event) {
        if (event.type === 'elicit_request') {
          yield* sleep(25)
          // Decline the flight selection
          yield* session.respondToElicit(event.elicitId, {
            action: 'decline',
          })
        }
      })

      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // book_flight_decline_seat - user accepts flight but declines seat
    // =========================================================================
    if (scenario === 'book_flight_decline_seat') {
      let elicitCount = 0
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'book_flight',
        params: { from: 'NYC', destination: 'LAX' },
        workerUrl,
      })

      yield* collectEvents(session, events, function* (event) {
        if (event.type === 'elicit_request') {
          yield* sleep(25)
          elicitCount++
          
          if (elicitCount === 1) {
            // Accept first elicit (pickFlight)
            yield* session.respondToElicit(event.elicitId, {
              action: 'accept',
              content: { flightId: 'FL001' },
            })
          } else {
            // Decline second elicit (pickSeat)
            yield* session.respondToElicit(event.elicitId, {
              action: 'decline',
            })
          }
        }
      })

      const resultEvent = yield* waitForEvent(events, 'result', 3000)
      const status = yield* session.status()

      const elicitRequests = events.filter((e) => e.type === 'elicit_request')

      return {
        status,
        elicitCount: elicitRequests.length,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // elicit_with_context - tests context data passing through elicit
    // =========================================================================
    if (scenario === 'elicit_with_context') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'elicit_with_context',
        params: {
          flights: [
            { id: 'FL001', airline: 'SkyHigh', price: 299 },
            { id: 'FL002', airline: 'CloudAir', price: 349 },
          ],
        },
        workerUrl,
      })

      let capturedContext: Record<string, unknown> | undefined

      yield* collectEvents(session, events, function* (event) {
        if (event.type === 'elicit_request') {
          capturedContext = event.context
          yield* sleep(25)
          yield* session.respondToElicit(event.elicitId, {
            action: 'accept',
            content: { flightId: 'FL001' },
          })
        }
      })

      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        // Verify context was passed through
        capturedContext,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // sample_with_options - tests sample with systemPrompt, maxTokens, etc.
    // =========================================================================
    if (scenario === 'sample_with_options') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'sample_with_options',
        params: {},
        workerUrl,
      })

      let capturedSampleRequest: {
        systemPrompt?: string
        maxTokens?: number
        modelPreferences?: unknown
      } | null = null

      yield* collectEvents(session, events, function* (event) {
        if (event.type === 'sample_request') {
          capturedSampleRequest = {
            systemPrompt: event.systemPrompt,
            maxTokens: event.maxTokens,
            modelPreferences: event.modelPreferences,
          }
          yield* sleep(25)
          yield* session.respondToSample(event.sampleId, {
            text: 'Hello there!',
            model: 'test-model',
            stopReason: 'endTurn',
          })
        }
      })

      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        // Verify optional fields were passed through
        capturedSampleRequest,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // sample_with_parsed - tests sample response with parsed field
    // =========================================================================
    if (scenario === 'sample_with_parsed') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'sample_with_parsed',
        params: {},
        workerUrl,
      })

      let capturedSchema: Record<string, unknown> | undefined

      yield* collectEvents(session, events, function* (event) {
        if (event.type === 'sample_request') {
          capturedSchema = event.schema
          yield* sleep(25)
          yield* session.respondToSample(event.sampleId, {
            text: '{"name": "Alice", "age": 30}',
            model: 'test-model',
            stopReason: 'endTurn',
            parsed: { name: 'Alice', age: 30 },
          })
        }
      })

      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        capturedSchema,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // sample_with_tools - tests sample response with toolCalls field
    // =========================================================================
    if (scenario === 'sample_with_tools') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'sample_with_tools',
        params: {},
        workerUrl,
      })

      let capturedTools: unknown[] | undefined
      let capturedToolChoice: unknown | undefined

      yield* collectEvents(session, events, function* (event) {
        if (event.type === 'sample_request') {
          capturedTools = event.tools
          capturedToolChoice = event.toolChoice
          yield* sleep(25)
          yield* session.respondToSample(event.sampleId, {
            text: '',
            model: 'test-model',
            stopReason: 'toolUse',
            toolCalls: [
              {
                id: 'call-123',
                name: 'get_weather',
                arguments: { location: 'New York' },
              },
            ],
          })
        }
      })

      const resultEvent = yield* waitForEvent(events, 'result', 2000)
      const status = yield* session.status()

      return {
        status,
        result: resultEvent?.type === 'result' ? resultEvent.result : null,
        capturedTools,
        capturedToolChoice,
        eventTypes: events.map((event) => event.type),
      }
    }

    // =========================================================================
    // events_after_lsn - tests resumability via afterLSN parameter
    // =========================================================================
    if (scenario === 'events_after_lsn') {
      const session = yield* createWorkerToolSession({
        sessionId: 'test-session',
        toolName: 'multi_sample',
        params: { count: 3 },
        workerUrl,
      })

      let sampleCount = 0

      yield* collectEvents(session, events, (event) =>
        respondToEventWithSampleSequence(session, event, () => {
          sampleCount++
          return `Response ${sampleCount}`
        })
      )

      // Wait for completion
      yield* waitForEvent(events, 'result', 3000)

      // Now test the afterLSN feature - get events starting after LSN 2
      const eventsAfter2: ToolSessionEvent[] = []
      yield* spawn(function* () {
        for (const event of yield* each(session.events(2))) {
          eventsAfter2.push(event)
          yield* each.next()
        }
      })
      
      // Give it a moment to collect
      yield* sleep(50)

      return {
        totalEventCount: events.length,
        // Events after LSN 2 should skip the first 2 events
        eventsAfter2Count: eventsAfter2.length,
        firstEventAfter2Lsn: eventsAfter2[0]?.lsn ?? null,
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
