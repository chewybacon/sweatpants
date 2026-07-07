import { describe, it, expect } from 'vitest'

import {
  sanitizeRecord,
  projectLogRecord,
  projectStatus,
  type ProjectionContext,
} from '../projections.ts'
import type {
  LogRecord,
  WaitRecord,
  AnswerRecord,
  CheckpointRecord,
  TerminalRecord,
  EmissionRecord,
  FateRecord,
  SessionStatus,
} from '../types.ts'

const defaultContext: ProjectionContext = {
  turnSeq: 0,
  pendingCallCount: 0,
  authorized: false,
}

describe('sanitizeRecord (REQ-080)', () => {
  it('strips checkpoint.state', () => {
    const record: CheckpointRecord = {
      lsn: 1,
      kind: 'checkpoint',
      mode: 'fold',
      waitSeqWatermark: 0,
      state: { internalState: 'secret' },
    }
    const sanitized = sanitizeRecord(record) as CheckpointRecord
    expect(sanitized.state).toBeUndefined()
    expect(sanitized.kind).toBe('checkpoint')
    expect(sanitized.mode).toBe('fold')
  })

  it('strips answer.resolution', () => {
    const record: AnswerRecord = {
      lsn: 2,
      kind: 'answer',
      waitSeq: 1,
      wait: 'call',
      payload: { ok: true, value: 'result' },
      idempotencyKey: 'key-1',
      resolution: { provider: 'stub', childSessionId: 'child-123', durationMs: 42 },
    }
    const sanitized = sanitizeRecord(record) as AnswerRecord
    expect(sanitized.resolution).toBeUndefined()
    expect(sanitized.payload).toEqual({ ok: true, value: 'result' })
  })

  it('strips sample system prompts when unauthorized', () => {
    const record: WaitRecord<'sample'> = {
      lsn: 3,
      kind: 'wait',
      waitSeq: 1,
      wait: 'sample',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
        options: { system: 'secret system prompt', maxTokens: 100 },
      },
    }
    const sanitized = sanitizeRecord(record, false) as WaitRecord<'sample'>
    expect(sanitized.payload.options?.['system']).toBeUndefined()
    expect(sanitized.payload.options?.['maxTokens']).toBe(100)
  })

  it('preserves sample system prompts when authorized', () => {
    const record: WaitRecord<'sample'> = {
      lsn: 3,
      kind: 'wait',
      waitSeq: 1,
      wait: 'sample',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
        options: { system: 'secret system prompt', maxTokens: 100 },
      },
    }
    const sanitized = sanitizeRecord(record, true) as WaitRecord<'sample'>
    expect(sanitized.payload.options?.['system']).toBe('secret system prompt')
  })

  it('is a pure function — same input, same output', () => {
    const record: CheckpointRecord = {
      lsn: 1,
      kind: 'checkpoint',
      mode: 'fold',
      waitSeqWatermark: 0,
      state: { internalState: 'secret' },
    }
    const result1 = sanitizeRecord(record)
    const result2 = sanitizeRecord(record)
    expect(result1).toEqual(result2)
  })

  // TC-N03: topology fields do not appear on the wire
  it('does not leak childSessionId through answer.resolution', () => {
    const record: AnswerRecord = {
      lsn: 2,
      kind: 'answer',
      waitSeq: 1,
      wait: 'call',
      payload: { ok: true, value: 'result' },
      idempotencyKey: 'key-1',
      resolution: { childSessionId: 'child-123' },
    }
    const sanitized = sanitizeRecord(record)
    const json = JSON.stringify(sanitized)
    expect(json).not.toContain('childSessionId')
    expect(json).not.toContain('child-123')
  })
})

describe('projectLogRecord (REQ-074)', () => {
  it('projects elicit wait to RUN_FINISHED with interrupt', () => {
    const record: WaitRecord<'elicit'> = {
      lsn: 1,
      kind: 'wait',
      waitSeq: 1,
      wait: 'elicit',
      payload: { key: 'confirm', message: 'Are you sure?', responseSchema: { type: 'boolean' } },
    }
    const events = projectLogRecord(record, defaultContext)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('RUN_FINISHED')
    expect(events[0]!.interrupt).toBeDefined()
  })

  it('projects text_delta emission to TEXT_MESSAGE_CONTENT', () => {
    const record: EmissionRecord = {
      lsn: 2,
      kind: 'emission',
      payload: { type: 'text_delta', delta: 'hel' },
    }
    const events = projectLogRecord(record, defaultContext)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('TEXT_MESSAGE_CONTENT')
    expect(events[0]!['delta']).toBe('hel')
  })

  it('projects terminal to RUN_FINISHED with outcome', () => {
    const record: TerminalRecord = {
      lsn: 5,
      kind: 'terminal',
      outcome: 'result',
      payload: { ok: true, value: 'done' },
    }
    const events = projectLogRecord(record, defaultContext)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('RUN_FINISHED')
    expect(events[0]!['outcome']).toBe('result')
  })

  it('projects message wait to TURN_BOUNDARY', () => {
    const record: WaitRecord<'message'> = {
      lsn: 4,
      kind: 'wait',
      waitSeq: 2,
      wait: 'message',
      payload: {},
    }
    const events = projectLogRecord(record, { ...defaultContext, turnSeq: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('TURN_BOUNDARY')
    expect(events[0]!['turnSeq']).toBe(1)
  })

  it('is a pure function — same input, same output', () => {
    const record: EmissionRecord = {
      lsn: 2,
      kind: 'emission',
      payload: { type: 'text_delta', delta: 'test' },
    }
    const events1 = projectLogRecord(record, defaultContext)
    const events2 = projectLogRecord(record, defaultContext)
    expect(events1).toEqual(events2)
  })

  it('is testable without a running server (no HTTP, no effection)', () => {
    const record: LogRecord = {
      lsn: 1,
      kind: 'wait',
      waitSeq: 1,
      wait: 'elicit',
      payload: { key: 'test', message: 'test', responseSchema: {} },
    }
    // This call works without any server, HTTP, or effection scope
    const events = projectLogRecord(record, defaultContext)
    expect(events).toBeDefined()
    expect(Array.isArray(events)).toBe(true)
  })
})

describe('projectStatus (REQ-082)', () => {
  it('projects terminal status to RUN_FINISHED', () => {
    const status: SessionStatus = {
      state: 'completed',
      pendingWaits: [],
      terminal: { outcome: 'result', payload: { value: 'done' } },
    }
    const event = projectStatus(status, defaultContext)
    expect(event.type).toBe('RUN_FINISHED')
  })
})
