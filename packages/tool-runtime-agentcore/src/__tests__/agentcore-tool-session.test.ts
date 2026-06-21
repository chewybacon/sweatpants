// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { run, each } from 'effection'
import { z } from 'zod'
import { createMcpTool, useToolSessionRegistry } from '@sweatpants/framework/chat/mcp-tools'
import {
  AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
  FakeAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolSession,
  createAgentCoreToolSessionRegistry,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  setupAgentCoreToolSessions,
  streamFromAgentCoreResponses
} from '../index.ts'
import type { AgentCoreToolRuntimeProfile, AgentCoreToolSessionHandle, AgentCoreToolSessionStores, RemoteToolRuntimeClient } from '../index.ts'

function createStores(): AgentCoreToolSessionStores {
  return {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  }
}

function createProfile(toolNames: string[]): AgentCoreToolRuntimeProfile {
  return {
    name: 'test-profile',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test',
    endpointName: 'DEFAULT',
    region: 'us-east-1',
    toolNames,
    maxSessionTtlMs: 60_000,
  }
}

const simpleTool = createMcpTool('simple_tool')
  .description('simple')
  .parameters(z.object({ input: z.string() }))
  .elicits({})
  .execute(function* (params) {
    return { input: params.input }
  })

const elicitTool = createMcpTool('elicit_tool')
  .description('elicit')
  .parameters(z.object({}))
  .elicits({})
  .execute(function* () {
    return { ok: true }
  })

const sampleTool = createMcpTool('sample_tool')
  .description('sample')
  .parameters(z.object({}))
  .elicits({})
  .execute(function* () {
    return { ok: true }
  })

describe('AgentCore ToolSession facade', () => {
  it('creates a serializable handle and records remote result events', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['simple_tool'])],
      createRuntimeSessionId: (sessionId) => `runtime-${sessionId}`,
    })

    const result = await run(function* () {
      const session = yield* registry.create(simpleTool, { input: 'hello' }, { sessionId: 'call_simple' })
      const status = yield* session.status()
      const handle = yield* stores.handles.get('call_simple')
      const events = yield* stores.events.readAfter('call_simple', 0)
      return { status, handle, events }
    })

    expect(result.status).toBe('completed')
    expect(result.handle).toMatchObject({
      kind: 'agentcore-tool-session',
      version: 1,
      protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
      sessionId: 'call_simple',
      callId: 'call_simple',
      runtimeSessionId: 'runtime-call_simple',
      status: 'completed',
    })
    expect(JSON.parse(JSON.stringify(result.handle))).toEqual(result.handle)
    expect(result.events.events.map(({ event }) => event.type)).toEqual(['progress', 'result'])
  })

  it('pauses for elicit and resumes via respondToElicit using the same runtimeSessionId', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['elicit_tool'])],
      createRuntimeSessionId: () => 'runtime-elicit',
    })

    const result = await run(function* () {
      const session = yield* registry.create(elicitTool, {}, { sessionId: 'call_elicit' })
      expect(yield* session.status()).toBe('awaiting_elicit')
      const handleBefore = yield* stores.handles.get('call_elicit')
      expect(handleBefore?.pendingRequest).toEqual({ type: 'elicit', elicitId: 'call_elicit:elicit:1' })

      yield* session.respondToElicit('call_elicit:elicit:1', {
        action: 'accept',
        content: { confirmed: true },
      })

      const status = yield* session.status()
      const handleAfter = yield* stores.handles.get('call_elicit')
      const events = yield* stores.events.readAfter('call_elicit', 0)
      return { status, handleAfter, events, invocations: runtime.invocations }
    })

    expect(result.status).toBe('completed')
    expect(result.handleAfter?.pendingRequest).toBeUndefined()
    expect(result.events.events.map(({ event }) => event.type)).toEqual(['progress', 'elicit_request', 'result'])
    expect(result.invocations.filter((entry) => entry.op === 'start_tool_session' || entry.op === 'respond_to_elicit').map((entry) => entry.runtimeSessionId)).toEqual(['runtime-elicit', 'runtime-elicit'])
  })

  it('rejects mismatched pending elicit id locally', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['elicit_tool'])],
    })

    await expect(run(function* () {
      const session = yield* registry.create(elicitTool, {}, { sessionId: 'call_elicit_bad' })
      yield* session.respondToElicit('wrong', { action: 'accept', content: {} })
    })).rejects.toThrow(/Elicitation ID mismatch/)
  })

  it('pauses for sample and resumes via respondToSample', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['sample_tool'])],
      createRuntimeSessionId: () => 'runtime-sample',
    })

    const result = await run(function* () {
      const session = yield* registry.create(sampleTool, {}, { sessionId: 'call_sample' })
      expect(yield* session.status()).toBe('awaiting_sample')
      yield* session.respondToSample('call_sample:sample:1', { text: 'hello model' })
      return {
        status: yield* session.status(),
        events: yield* stores.events.readAfter('call_sample', 0),
        invocations: runtime.invocations,
      }
    })

    expect(result.status).toBe('completed')
    expect(result.events.events.map(({ event }) => event.type)).toEqual(['progress', 'sample_request', 'result'])
    expect(result.invocations.filter((entry) => entry.op === 'start_tool_session' || entry.op === 'respond_to_sample').map((entry) => entry.runtimeSessionId)).toEqual(['runtime-sample', 'runtime-sample'])
  })

  it('rehydrates a facade from a serialized handle and replays events after LSN', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['simple_tool'])],
    })

    const result = await run(function* () {
      yield* registry.create(simpleTool, { input: 'hello' }, { sessionId: 'call_rehydrate' })
      const rehydrated = yield* registry.acquire('call_rehydrate')
      const sub = yield* rehydrated.events(1)
      const replayed = []
      let next = yield* sub.next()
      while (!next.done) {
        replayed.push(next.value.type)
        next = yield* sub.next()
      }
      return replayed
    })

    expect(result).toEqual(['result'])
  })

  it('marks a non-terminal session orphaned when remote runtime cannot find it', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['elicit_tool'])],
    })

    const result = await run(function* () {
      const session = yield* registry.create(elicitTool, {}, { sessionId: 'call_orphan' })
      runtime.sessions.clear()
      yield* session.respondToElicit('call_orphan:elicit:1', { action: 'accept', content: {} })
      return {
        status: yield* session.status(),
        events: yield* stores.events.readAfter('call_orphan', 0),
      }
    })

    expect(result.status).toBe('orphaned')
    expect(result.events.events.at(-1)?.event).toMatchObject({
      type: 'error',
      name: 'AgentCoreToolSessionOrphaned',
    })
  })

  it('setupAgentCoreToolSessions wires the AgentCore registry into context', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()

    const result = await run(function* () {
      yield* setupAgentCoreToolSessions({
        stores,
        runtimeClient: runtime,
        profiles: [createProfile(['simple_tool'])],
      })
      const registry = yield* useToolSessionRegistry()
      const session = yield* registry.create(simpleTool, { input: 'from-context' }, { sessionId: 'call_context' })
      return yield* session.status()
    })

    expect(result).toBe('completed')
  })

  it('uses stable command ids for retryable elicit, sample, and cancel commands', async () => {
    const elicitStores = createStores()
    const elicitRuntime = new FakeAgentCoreRemoteToolRuntimeClient()
    const elicitRegistry = createAgentCoreToolSessionRegistry({
      stores: elicitStores,
      runtimeClient: elicitRuntime,
      profiles: [createProfile(['elicit_tool'])],
    })

    const sampleStores = createStores()
    const sampleRuntime = new FakeAgentCoreRemoteToolRuntimeClient()
    const sampleRegistry = createAgentCoreToolSessionRegistry({
      stores: sampleStores,
      runtimeClient: sampleRuntime,
      profiles: [createProfile(['sample_tool'])],
    })

    const result = await run(function* () {
      const elicit = yield* elicitRegistry.create(elicitTool, {}, { sessionId: 'stable_elicit' })
      yield* elicit.respondToElicit('stable_elicit:elicit:1', { action: 'accept', content: {} })
      yield* elicit.respondToElicit('stable_elicit:elicit:1', { action: 'accept', content: {} })

      const sample = yield* sampleRegistry.create(sampleTool, {}, { sessionId: 'stable_sample' })
      yield* sample.respondToSample('stable_sample:sample:1', { text: 'hello' })
      yield* sample.respondToSample('stable_sample:sample:1', { text: 'hello' })

      const cancellableStores = createStores()
      const cancellableRuntime = new FakeAgentCoreRemoteToolRuntimeClient()
      const cancellableRegistry = createAgentCoreToolSessionRegistry({
        stores: cancellableStores,
        runtimeClient: cancellableRuntime,
        profiles: [createProfile(['elicit_tool'])],
      })
      const cancellable = yield* cancellableRegistry.create(elicitTool, {}, { sessionId: 'stable_cancel' })
      yield* cancellable.cancel('stop')

      return {
        elicitIds: elicitRuntime.invocations.filter((entry) => entry.op === 'respond_to_elicit').map((entry) => (entry.request as { commandId: string }).commandId),
        sampleIds: sampleRuntime.invocations.filter((entry) => entry.op === 'respond_to_sample').map((entry) => (entry.request as { commandId: string }).commandId),
        cancelId: (cancellableRuntime.invocations.find((entry) => entry.op === 'cancel_tool_session')?.request as { commandId: string }).commandId,
      }
    })

    expect(result.elicitIds).toEqual([result.elicitIds[0], result.elicitIds[0]])
    expect(result.sampleIds).toEqual([result.sampleIds[0], result.sampleIds[0]])
    expect(result.elicitIds[0]).not.toEqual(result.sampleIds[0])
    expect(result.cancelId).not.toEqual(result.elicitIds[0])
    expect(result.cancelId).not.toEqual(result.sampleIds[0])
  })

  it('rehydrated non-terminal handles lazily drain and reconcile runtime completion', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['elicit_tool'])],
    })

    const result = await run(function* () {
      yield* registry.create(elicitTool, {}, { sessionId: 'stale_rehydrate' })
      const fakeSession = [...runtime.sessions.values()][0] as any
      fakeSession.pending = undefined
      fakeSession.status = 'completed'
      fakeSession.events.push({ seq: 3, id: 'stale_rehydrate:3', event: { type: 'result', result: { ok: true } } })
      fakeSession.nextSeq = 4

      const rehydrated = yield* registry.acquire('stale_rehydrate')
      const status = yield* rehydrated.status()
      const handle = yield* stores.handles.get('stale_rehydrate')
      const events = yield* stores.events.readAfter('stale_rehydrate', 0)
      return { status, handle, events, invocations: runtime.invocations.map((entry) => entry.op) }
    })

    expect(result.invocations).toContain('drain_tool_session_events')
    expect(result.status).toBe('completed')
    expect(result.handle?.lastRuntimeEventSeq).toBe(3)
    expect(result.events.events.map(({ event }) => event.type)).toContain('result')
  })

  it('recovers command_duplicate by draining missing runtime events', async () => {
    const stores = createStores()
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient()
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(['elicit_tool'])],
    })

    const result = await run(function* () {
      const session = yield* registry.create(elicitTool, {}, { sessionId: 'duplicate_recover' })
      const request = {
        op: 'respond_to_elicit',
        protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
        commandId: ['respond_to_elicit', 'duplicate_recover', 'duplicate_recover:elicit:1'].map(encodeURIComponent).join(':'),
        toolSessionId: 'duplicate_recover',
        elicitId: 'duplicate_recover:elicit:1',
        response: { action: 'accept', content: { ok: true } },
      }
      const fakeSession = [...runtime.sessions.values()][0] as any
      fakeSession.acceptedCommands.set(request.commandId, JSON.stringify(request))
      fakeSession.pending = undefined
      fakeSession.status = 'completed'
      fakeSession.events.push({ seq: 3, id: 'duplicate_recover:3', event: { type: 'result', result: { ok: true } } })
      fakeSession.nextSeq = 4

      yield* session.respondToElicit('duplicate_recover:elicit:1', { action: 'accept', content: { ok: true } })
      return {
        status: yield* session.status(),
        handle: yield* stores.handles.get('duplicate_recover'),
        invocations: runtime.invocations.map((entry) => entry.op),
      }
    })

    expect(result.invocations).toContain('drain_tool_session_events')
    expect(result.status).toBe('completed')
    expect(result.handle?.lastRuntimeEventSeq).toBe(3)
  })

  it('does not regress terminal status or runtime sequence on stale replay', async () => {
    const stores = createStores()
    const handle: AgentCoreToolSessionHandle = {
      kind: 'agentcore-tool-session',
      version: 1,
      protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
      sessionId: 'stale_replay',
      toolName: 'elicit_tool',
      runtimeProfile: 'test-profile',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test',
      endpointName: 'DEFAULT',
      runtimeSessionId: 'runtime-stale-replay',
      region: 'us-east-1',
      status: 'completed',
      lastEventLsn: 1,
      lastRuntimeEventSeq: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const runtimeClient: RemoteToolRuntimeClient<AgentCoreToolSessionHandle> = {
      start: function* () { return streamFromAgentCoreResponses([]) },
      respondToElicit: function* () {
        return streamFromAgentCoreResponses([
          { type: 'tool_event', toolSessionId: 'stale_replay', runtimeEventSeq: 2, runtimeEventId: 'stale:2', event: { type: 'progress', message: 'old running' } },
          { type: 'session_status', toolSessionId: 'stale_replay', status: 'running', lastRuntimeEventSeq: 2 },
        ])
      },
      respondToSample: function* () { return streamFromAgentCoreResponses([]) },
      cancel: function* () { return streamFromAgentCoreResponses([]) },
      inspect: function* () { return { type: 'session_status', toolSessionId: 'stale_replay', status: 'running', lastRuntimeEventSeq: 2 } },
      drainEvents: function* () { return streamFromAgentCoreResponses([]) },
      stopRuntimeSession: function* () {},
    }

    const result = await run(function* () {
      yield* stores.handles.create(handle)
      yield* stores.events.appendRemoteEvent('stale_replay', 10, 'stale:10', { type: 'result', result: { ok: true } })
      yield* stores.events.markTerminal('stale_replay')
      const session = createAgentCoreToolSession({ handle, stores, runtimeClient })
      yield* session.respondToElicit('old-elicit', { action: 'accept', content: {} })
      return yield* stores.handles.get('stale_replay')
    })

    expect(result?.status).toBe('completed')
    expect(result?.lastRuntimeEventSeq).toBe(10)
  })

  it('deduplicates remote events by runtime sequence and id', async () => {
    const store = createInMemoryAgentCoreToolSessionEventStore()

    const result = await run(function* () {
      const first = yield* store.appendRemoteEvent('s1', 1, 's1:1', { type: 'progress', message: 'one' })
      const duplicate = yield* store.appendRemoteEvent('s1', 1, 's1:1', { type: 'progress', message: 'one' })
      return { first, duplicate }
    })

    expect(result).toEqual({ first: 1, duplicate: 1 })

    const sameSeqDifferentId = await run(function* () {
      return yield* store.appendRemoteEvent('s1', 1, 'different', { type: 'progress', message: 'one' })
    })
    expect(sameSeqDifferentId).toBe(2)

    const changedPayload = await run(function* () {
      return yield* store.appendRemoteEvent('s1', 1, 'different', { type: 'progress', message: 'changed' })
    })
    expect(changedPayload).toBe(3)
  })
})
