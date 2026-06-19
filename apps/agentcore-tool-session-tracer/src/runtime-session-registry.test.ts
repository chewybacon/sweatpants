// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type RuntimeRequest, type RuntimeResponse } from './protocol.ts'
import { RuntimeSessionRegistry } from './runtime-session-registry.ts'

const contextA = { runtimeSessionId: 'runtime-A' }
const contextB = { runtimeSessionId: 'runtime-B' }

function startRequest(overrides: Partial<Extract<RuntimeRequest, { op: 'start_tool_session' }>> = {}): Extract<RuntimeRequest, { op: 'start_tool_session' }> {
  return {
    op: 'start_tool_session',
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'cmd-start',
    toolSessionId: 'ts-1',
    toolName: 'simple_result',
    params: { value: 1 },
    ...overrides,
  }
}

function status(responses: RuntimeResponse[]): RuntimeResponse | undefined {
  return responses.find((response) => response.type === 'session_status')
}

describe('RuntimeSessionRegistry protocol safety', () => {
  it('isolates identical tool session ids by trusted runtime session id', async () => {
    const registry = new RuntimeSessionRegistry()

    await registry.handle(startRequest(), contextA)
    await registry.handle(startRequest({ commandId: 'cmd-start-b' }), contextB)

    const inspectA = await registry.handle({ op: 'inspect_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'inspect-a', toolSessionId: 'ts-1' }, contextA)
    const inspectB = await registry.handle({ op: 'inspect_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'inspect-b', toolSessionId: 'ts-1' }, contextB)

    expect(status(inspectA)).toMatchObject({ type: 'session_status', status: 'completed' })
    expect(status(inspectB)).toMatchObject({ type: 'session_status', status: 'completed' })
  })

  it('does not disclose or mutate sessions from the wrong runtime session', async () => {
    const registry = new RuntimeSessionRegistry()
    await registry.handle(startRequest({ toolSessionId: 'ts-owned' }), contextA)

    const wrongInspect = await registry.handle({ op: 'inspect_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'inspect', toolSessionId: 'ts-owned' }, contextB)
    const wrongDrain = await registry.handle({ op: 'drain_tool_session_events', protocolVersion: PROTOCOL_VERSION, commandId: 'drain', toolSessionId: 'ts-owned', afterRuntimeEventSeq: 0 }, contextB)
    const wrongCancel = await registry.handle({ op: 'cancel_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'cancel', toolSessionId: 'ts-owned' }, contextB)
    const ownerInspect = await registry.handle({ op: 'inspect_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'inspect-owner', toolSessionId: 'ts-owned' }, contextA)

    expect(wrongInspect).toEqual([{ type: 'session_not_found', toolSessionId: 'ts-owned' }])
    expect(wrongDrain).toEqual([{ type: 'session_not_found', toolSessionId: 'ts-owned' }])
    expect(wrongCancel).toEqual([{ type: 'session_not_found', toolSessionId: 'ts-owned' }])
    expect(status(ownerInspect)).toMatchObject({ type: 'session_status', status: 'completed' })
  })

  it('distinguishes exact duplicate start from conflicting session-key reuse without mutation', async () => {
    const registry = new RuntimeSessionRegistry()
    const start = startRequest({ toolSessionId: 'ts-dup' })
    const first = await registry.handle(start, contextA)
    const duplicate = await registry.handle(start, contextA)
    const conflict = await registry.handle(startRequest({ toolSessionId: 'ts-dup', commandId: 'cmd-start-conflict', params: { value: 2 } }), contextA)
    const inspect = await registry.handle({ op: 'inspect_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'inspect', toolSessionId: 'ts-dup' }, contextA)

    expect(first.some((response) => response.type === 'tool_event' && response.event.type === 'result')).toBe(true)
    expect(duplicate[0]).toMatchObject({ type: 'command_duplicate', commandId: 'cmd-start' })
    expect(conflict).toEqual([{ type: 'command_conflict', toolSessionId: 'ts-dup', commandId: 'cmd-start-conflict', message: 'toolSessionId already exists with different start command' }])
    expect(status(inspect)).toMatchObject({ type: 'session_status', status: 'completed', lastRuntimeEventSeq: 2 })
  })

  it('keeps terminal sessions immutable for late cancel and late responses', async () => {
    const registry = new RuntimeSessionRegistry()
    await registry.handle(startRequest({ toolSessionId: 'ts-terminal' }), contextA)

    const cancel = await registry.handle({ op: 'cancel_tool_session', protocolVersion: PROTOCOL_VERSION, commandId: 'late-cancel', toolSessionId: 'ts-terminal' }, contextA)
    const elicit = await registry.handle({ op: 'respond_to_elicit', protocolVersion: PROTOCOL_VERSION, commandId: 'late-elicit', toolSessionId: 'ts-terminal', elicitId: 'stale', response: { action: 'accept', content: {} } }, contextA)
    const sample = await registry.handle({ op: 'respond_to_sample', protocolVersion: PROTOCOL_VERSION, commandId: 'late-sample', toolSessionId: 'ts-terminal', sampleId: 'stale', response: { text: 'late' } }, contextA)
    const drain = await registry.handle({ op: 'drain_tool_session_events', protocolVersion: PROTOCOL_VERSION, commandId: 'drain', toolSessionId: 'ts-terminal', afterRuntimeEventSeq: 0 }, contextA)

    expect(status(cancel)).toMatchObject({ type: 'session_status', status: 'completed' })
    expect(status(elicit)).toMatchObject({ type: 'session_status', status: 'completed' })
    expect(status(sample)).toMatchObject({ type: 'session_status', status: 'completed' })
    expect(drain.filter((response) => response.type === 'tool_event').map((response) => response.type === 'tool_event' ? response.event.type : response.type)).toEqual(['progress', 'result'])
  })
})
