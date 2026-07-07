import { run, type Operation, type Subscription } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { adaptToolSessionToSessionContract } from '@sweatpants/framework/chat/mcp-tools'
import type { LogRecord, Session } from '@sweatpants/session-contract'

import {
  FakeAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolSessionRegistry,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolSessionStores,
} from '../src/index.ts'

function createStores(): AgentCoreToolSessionStores {
  return {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  }
}

function createProfile(toolNames: string[]): AgentCoreToolRuntimeProfile {
  return {
    name: 'contract-profile',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test',
    endpointName: 'DEFAULT',
    region: 'us-east-1',
    toolNames,
    maxSessionTtlMs: 60_000,
  }
}

const RemoteElicitTool = createTool('session_contract_agentcore_elicit')
  .description('Remote elicit tool')
  .parameters(z.object({}))
  .execute(function* () {
    return { unreachable: true }
  })

const RemoteSampleTool = createTool('session_contract_agentcore_sample')
  .description('Remote sample tool')
  .parameters(z.object({}))
  .execute(function* () {
    return { unreachable: true }
  })

describe('@sweatpants/tool-runtime-agentcore session-contract adapter', () => {
  it('projects AgentCore elicitation sessions into the base session contract', async () => {
    await run(function* () {
      const registry = createAgentCoreToolSessionRegistry({
        stores: createStores(),
        runtimeClient: new FakeAgentCoreRemoteToolRuntimeClient(),
        profiles: [createProfile(['session_contract_agentcore_elicit'])],
        createRuntimeSessionId: () => 'runtime-contract-elicit',
      })

      const toolSession = yield* registry.create(RemoteElicitTool, {}, { sessionId: 'agentcore-contract-elicit' })
      const session = yield* adaptToolSessionToSessionContract(toolSession)
      const events = yield* session.events()

      const wait = yield* nextWait(events)
      expect(wait.wait).toBe('elicit')
      expect(wait.waitSeq).toBe(1)

      const pending = yield* expectOnePendingWait(session, 'elicit')
      yield* session.respond(pending.token, { confirmed: true }, {
        idempotencyKey: 'agentcore-elicit-answer',
        wait: 'elicit',
      })

      const terminal = yield* nextTerminal(events)
      expect(terminal).toMatchObject({ kind: 'terminal', outcome: 'result', payload: { confirmed: true } })
    })
  })

  it('projects AgentCore sample sessions into the base session contract', async () => {
    await run(function* () {
      const registry = createAgentCoreToolSessionRegistry({
        stores: createStores(),
        runtimeClient: new FakeAgentCoreRemoteToolRuntimeClient(),
        profiles: [createProfile(['session_contract_agentcore_sample'])],
        createRuntimeSessionId: () => 'runtime-contract-sample',
      })

      const toolSession = yield* registry.create(RemoteSampleTool, {}, { sessionId: 'agentcore-contract-sample' })
      const session = yield* adaptToolSessionToSessionContract(toolSession)
      const events = yield* session.events()

      const wait = yield* nextWait(events)
      expect(wait.wait).toBe('sample')

      const pending = yield* expectOnePendingWait(session, 'sample')
      yield* session.respond(
        pending.token,
        { text: 'remote hello' },
        { idempotencyKey: 'agentcore-sample-answer', wait: 'sample' },
      )

      const terminal = yield* nextTerminal(events)
      expect(terminal).toMatchObject({ kind: 'terminal', outcome: 'result', payload: { text: 'remote hello' } })
    })
  })
})

function* expectOnePendingWait(session: Session, kind: 'elicit' | 'sample'): Operation<{ token: string; waitSeq: number; kind: 'elicit' | 'sample' }> {
  const status = yield* session.status()
  expect(status.state).toBe('parked')
  expect(status.pendingWaits).toHaveLength(1)
  expect(status.pendingWaits[0]?.kind).toBe(kind)
  return status.pendingWaits[0] as { token: string; waitSeq: number; kind: 'elicit' | 'sample' }
}

function* nextWait(events: Subscription<LogRecord, void>): Operation<Extract<LogRecord, { kind: 'wait' }>> {
  return yield* nextRecord(events, (record): record is Extract<LogRecord, { kind: 'wait' }> => record.kind === 'wait')
}

function* nextTerminal(events: Subscription<LogRecord, void>): Operation<Extract<LogRecord, { kind: 'terminal' }>> {
  return yield* nextRecord(events, (record): record is Extract<LogRecord, { kind: 'terminal' }> => record.kind === 'terminal')
}

function* nextRecord<TRecord extends LogRecord>(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => record is TRecord,
): Operation<TRecord>
function* nextRecord(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => boolean,
): Operation<LogRecord>
function* nextRecord(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => boolean,
): Operation<LogRecord> {
  let next = yield* events.next()
  while (!next.done) {
    if (predicate(next.value)) {
      return next.value
    }
    next = yield* events.next()
  }
  throw new Error('Expected matching record before stream completion')
}
