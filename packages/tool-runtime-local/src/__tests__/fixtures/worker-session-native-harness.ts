/**
 * Test harness for the session-contract-native worker tool session.
 *
 * Run as: tsx worker-session-native-harness.ts <scenario>
 * Outputs JSON result on the last line of stdout.
 */

import { run, spawn, each, sleep } from 'effection'
import type { Operation } from 'effection'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createNativeWorkerToolSession, respondToNativeElicit, respondToNativeSample } from '../../worker-session-native.ts'
import type { InMemorySession, LogRecord } from '@sweatpants/session-contract'

const scenario = process.argv[2]
if (!scenario) {
  throw new Error('Scenario argument is required')
}

const workerPathCandidates = [
  resolve(process.cwd(), 'src/__tests__/fixtures/tool-worker.mjs'),
  resolve(process.cwd(), 'packages/tool-runtime-local/src/__tests__/fixtures/tool-worker.mjs'),
]

const workerPath = (() => {
  const candidate = workerPathCandidates.find((path) => existsSync(path))
  if (!candidate) {
    throw new Error('Failed to resolve tool-worker.mjs fixture path')
  }
  return candidate
})()

const workerUrl = pathToFileURL(workerPath)

function* watchSession(session: InMemorySession, records: LogRecord[]): Operation<void> {
  yield* spawn(function* () {
    for (const record of yield* each(session.events())) {
      records.push(record)

      // Auto-respond to elicit waits
      if (record.kind === 'wait' && record.wait === 'elicit') {
        yield* sleep(25)
        yield* respondToNativeElicit(session, record.payload.key, {
          action: 'accept',
          content: { confirmed: true, flightId: 'FL001', row: 12, seat: 'A', approved: true, newGreeting: '' },
        })
      }

      // Auto-respond to sample waits
      if (record.kind === 'wait' && record.wait === 'sample') {
        yield* sleep(25)
        yield* respondToNativeSample(session, String(record.waitSeq), {
          text: 'Hello from the model!',
          model: 'test-model',
          stopReason: 'endTurn',
        })
      }

      yield* each.next()
    }
  })
}

function* waitForTerminal(session: InMemorySession, timeoutMs = 10_000): Operation<LogRecord | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = yield* session.status()
    if (status.terminal) {
      const records = yield* session.records()
      return records.find((r) => r.kind === 'terminal') ?? null
    }
    yield* sleep(10)
  }
  return null
}

const scenarios: Record<string, () => Operation<Record<string, unknown>>> = {
  echo: function* () {
    const session = yield* createNativeWorkerToolSession({
      sessionId: 'native-echo',
      toolName: 'echo',
      params: { message: 'hello' },
      workerUrl,
    })
    const records: LogRecord[] = []
    yield* watchSession(session, records)
    const terminal = yield* waitForTerminal(session)
    const status = yield* session.status()
    return {
      status: status.state,
      outcome: terminal?.kind === 'terminal' ? terminal.outcome : null,
      result: terminal?.kind === 'terminal' ? terminal.payload : null,
    }
  },

  greeter: function* () {
    const session = yield* createNativeWorkerToolSession({
      sessionId: 'native-greeter',
      toolName: 'greeter',
      params: { name: 'Alice' },
      workerUrl,
    })
    const records: LogRecord[] = []
    yield* watchSession(session, records)
    const terminal = yield* waitForTerminal(session)
    const status = yield* session.status()
    const hasSampleWait = records.some((r) => r.kind === 'wait' && r.wait === 'sample')
    const hasSampleAnswer = records.some((r) => r.kind === 'answer' && r.wait === 'sample')
    return {
      status: status.state,
      outcome: terminal?.kind === 'terminal' ? terminal.outcome : null,
      result: terminal?.kind === 'terminal' ? terminal.payload : null,
      hasSampleWait,
      hasSampleAnswer,
    }
  },

  confirmer: function* () {
    const session = yield* createNativeWorkerToolSession({
      sessionId: 'native-confirmer',
      toolName: 'confirmer',
      params: { action: 'proceed' },
      workerUrl,
    })
    const records: LogRecord[] = []
    yield* watchSession(session, records)
    const terminal = yield* waitForTerminal(session)
    const status = yield* session.status()
    const hasElicitWait = records.some((r) => r.kind === 'wait' && r.wait === 'elicit')
    const hasElicitAnswer = records.some((r) => r.kind === 'answer' && r.wait === 'elicit')
    return {
      status: status.state,
      outcome: terminal?.kind === 'terminal' ? terminal.outcome : null,
      result: terminal?.kind === 'terminal' ? terminal.payload : null,
      hasElicitWait,
      hasElicitAnswer,
    }
  },
}

const fn = scenarios[scenario]
if (!fn) {
  throw new Error(`Unknown scenario: ${scenario}. Available: ${Object.keys(scenarios).join(', ')}`)
}

run(fn).then(
  (result) => console.log(JSON.stringify(result)),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
