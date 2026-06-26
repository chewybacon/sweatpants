import { describe, expect, it } from 'vitest'

import {
  aguiResumeToElicitResult,
  elicitResultToAGUIResume,
  toA2ACancelTaskProjection,
  toA2AInterruptedTaskStatus,
  toAGUIInterrupt,
} from '../projections.ts'
import type { InterruptDescriptor } from '../events.ts'

const interrupt: InterruptDescriptor = {
  id: 'int-1',
  key: 'pickFlight',
  seq: 0,
  reason: 'confirmation',
  message: 'Pick a flight',
  responseSchema: { type: 'object' },
  contextSchema: { type: 'object' },
  context: { flights: ['FL001'] },
  toolCallId: 'tool-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  metadata: { source: 'test' },
}

describe('protocol projections', () => {
  it('maps core interrupt to AG-UI and preserves sweatpants metadata', () => {
    const agui = toAGUIInterrupt(interrupt)
    expect(agui.interruptId).toBe('int-1')
    expect(agui.toolCallId).toBe('tool-1')
    expect(agui.responseSchema).toEqual({ type: 'object' })
    expect(agui.metadata.sweatpants.context).toEqual({ flights: ['FL001'] })
    expect(agui.metadata.sweatpants.key).toBe('pickFlight')
  })

  it('maps elicit accept/decline/cancel to AG-UI resume statuses and back', () => {
    expect(elicitResultToAGUIResume('int-1', { action: 'accept', content: { ok: true } })).toEqual({
      interruptId: 'int-1',
      status: 'resolved',
      payload: { ok: true },
    })
    expect(elicitResultToAGUIResume('int-1', { action: 'decline' })).toEqual({
      interruptId: 'int-1',
      status: 'cancelled',
    })
    expect(aguiResumeToElicitResult({ interruptId: 'int-1', status: 'resolved', payload: { ok: true } })).toEqual({
      action: 'accept',
      content: { ok: true },
    })
    expect(aguiResumeToElicitResult({ interruptId: 'int-1', status: 'cancelled' })).toEqual({ action: 'cancel' })
  })

  it('maps core interrupt and abort to exact A2A enum strings', () => {
    const status = toA2AInterruptedTaskStatus(interrupt, { contextId: 'ctx-1', taskId: 'task-1' })
    expect(status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(status.metadata.responseSchema).toEqual({ type: 'object' })
    expect(status.metadata.context).toEqual({ flights: ['FL001'] })

    expect(toA2ACancelTaskProjection({ contextId: 'ctx-1', taskId: 'task-1' })).toEqual({
      method: 'CancelTask',
      state: 'TASK_STATE_CANCELED',
      contextId: 'ctx-1',
      taskId: 'task-1',
    })
  })
})
