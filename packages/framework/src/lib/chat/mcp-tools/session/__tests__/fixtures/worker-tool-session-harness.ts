import { run, spawn, sleep, each } from 'effection'
import type { Operation } from 'effection'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createWorkerToolSession } from '../../worker-tool-session.ts'
import type { ToolSession, ToolSessionEvent } from '../../types.ts'
import type {
  SampleRequestHandler,
  ElicitRequestHandler,
} from '../../worker-tool-session.ts'

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

function* collectEvents(session: ToolSession, events: ToolSessionEvent[]) {
  yield* spawn(function* () {
    for (const event of yield* each(session.events())) {
      events.push(event)
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

function createUnexpectedSampleHandler(): SampleRequestHandler {
  return function* () {
    throw new Error('Unexpected sample request')
  }
}

function createUnexpectedElicitHandler(): ElicitRequestHandler {
  return function* () {
    throw new Error('Unexpected elicit request')
  }
}

async function main() {
  const result = await run(function* () {
    const events: ToolSessionEvent[] = []

    if (scenario === 'echo') {
      const session = yield* createWorkerToolSession(
        {
          sessionId: 'test-session',
          toolName: 'echo',
          params: { message: 'hello' },
          workerUrl,
        },
        createUnexpectedSampleHandler(),
        createUnexpectedElicitHandler()
      )

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
      const session = yield* createWorkerToolSession(
        {
          sessionId: 'test-session',
          toolName: 'missing_tool',
          params: {},
          workerUrl,
        },
        createUnexpectedSampleHandler(),
        createUnexpectedElicitHandler()
      )

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
      const onSampleRequest: SampleRequestHandler = function* () {
        yield* sleep(25)
        return {
          text: 'Hello, Alice!',
          model: 'test-model',
          stopReason: 'endTurn',
        }
      }

      const session = yield* createWorkerToolSession(
        {
          sessionId: 'test-session',
          toolName: 'greeter',
          params: { name: 'Alice' },
          workerUrl,
        },
        onSampleRequest,
        createUnexpectedElicitHandler()
      )

      yield* collectEvents(session, events)
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

    if (scenario === 'elicit') {
      const onElicitRequest: ElicitRequestHandler = function* () {
        yield* sleep(25)
        return {
          action: 'accept',
          content: { confirmed: true },
        }
      }

      const session = yield* createWorkerToolSession(
        {
          sessionId: 'test-session',
          toolName: 'confirmer',
          params: { action: 'delete files' },
          workerUrl,
        },
        createUnexpectedSampleHandler(),
        onElicitRequest
      )

      yield* collectEvents(session, events)
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

    throw new Error(`Unknown scenario: ${scenario}`)
  })

  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
