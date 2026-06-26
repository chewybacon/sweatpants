import { describe, it, expect } from '@effectionx/vitest'

import { createAgentStream, createInMemoryAgentStreamStore } from '../stream.ts'
import { isAgentEvent, isCommand } from '../log.ts'
import type { AgentEvent } from '../events.ts'

describe('AgentEvent vocabulary (REQ-020)', () => {
  it('events are LSN-tagged and timestamped on append', function* () {
    const store = createInMemoryAgentStreamStore()
    const buffer = yield* store.getOrCreate('ctx-1')
    const stream = createAgentStream('ctx-1', buffer, store.checkpointIndex)

    const e1 = (yield* stream.append({
      type: 'text_delta',
      messageId: 'm1',
      delta: 'hello',
    } as AgentEvent)) as AgentEvent
    const e2 = (yield* stream.append({
      type: 'progress',
      message: 'working',
    } as AgentEvent)) as AgentEvent

    expect(e1.lsn).toBe(0)
    expect(e1.timestamp).toBeGreaterThan(0)
    expect(e2.lsn).toBe(1)
    expect(e1.type).toBe('text_delta')
    expect(e2.type).toBe('progress')
  })

  it('isAgentEvent distinguishes events from commands', function* () {
    const store = createInMemoryAgentStreamStore()
    const buffer = yield* store.getOrCreate('ctx-2')
    const stream = createAgentStream('ctx-2', buffer, store.checkpointIndex)

    const event = yield* stream.append({ type: 'progress', message: 'x' } as AgentEvent)
    const cmd = yield* stream.append({
      type: 'sendMessage',
      message: 'hi',
      command: true,
    } as never)

    expect(isAgentEvent(event as never)).toBe(true)
    expect(isAgentEvent(cmd as never)).toBe(false)
    expect(isCommand(cmd as never)).toBe(true)
    expect(isCommand(event as never)).toBe(false)
  })

  it('events(afterLSN) resumes from the given LSN', function* () {
    const store = createInMemoryAgentStreamStore()
    const buffer = yield* store.getOrCreate('ctx-3')
    const stream = createAgentStream('ctx-3', buffer, store.checkpointIndex)

    yield* stream.append({ type: 'progress', message: 'a' } as AgentEvent)
    yield* stream.append({ type: 'progress', message: 'b' } as AgentEvent)
    yield* stream.append({ type: 'progress', message: 'c' } as AgentEvent)

    const { entries } = yield* stream.readEntries(1)
    expect(entries.map((e) => (e as AgentEvent).type)).toEqual([
      'progress',
      'progress',
    ])
    expect((entries[0] as AgentEvent).lsn).toBe(1)
  })

  it('records and looks up the latest checkpoint LSN (REQ-013)', function* () {
    const store = createInMemoryAgentStreamStore()
    const buffer = yield* store.getOrCreate('ctx-4')
    const stream = createAgentStream('ctx-4', buffer, store.checkpointIndex)

    expect(stream.latestCheckpointLsn()).toBeUndefined()
    stream.recordCheckpoint(5)
    stream.recordCheckpoint(3)
    stream.recordCheckpoint(9)
    expect(stream.latestCheckpointLsn()).toBe(9)
  })
})
