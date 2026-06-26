/** Protocol projection helpers for unified interrupts (REQ-021/022). */

import type { InterruptDescriptor, RawElicitResult } from './events.ts'

export interface AGUIInterrupt {
  interruptId: string
  id: string
  reason: string
  message: string
  toolCallId?: string
  responseSchema?: unknown
  expiresAt?: string
  metadata: {
    sweatpants: {
      key: string
      seq: number
      context?: unknown
      contextSchema?: unknown
      metadata?: Record<string, unknown>
    }
    [key: string]: unknown
  }
}

export type AGUIResume =
  | { interruptId: string; status: 'resolved'; payload: unknown }
  | { interruptId: string; status: 'cancelled'; payload?: unknown }

export function toAGUIInterrupt(interrupt: InterruptDescriptor): AGUIInterrupt {
  return {
    interruptId: interrupt.id,
    id: interrupt.id,
    reason: interrupt.reason,
    message: interrupt.message,
    ...(interrupt.toolCallId !== undefined ? { toolCallId: interrupt.toolCallId } : {}),
    ...(interrupt.responseSchema !== undefined ? { responseSchema: interrupt.responseSchema } : {}),
    ...(interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : {}),
    metadata: {
      ...(interrupt.metadata ?? {}),
      sweatpants: {
        key: interrupt.key,
        seq: interrupt.seq,
        ...(interrupt.context !== undefined ? { context: interrupt.context } : {}),
        ...(interrupt.contextSchema !== undefined ? { contextSchema: interrupt.contextSchema } : {}),
        ...(interrupt.metadata !== undefined ? { metadata: interrupt.metadata } : {}),
      },
    },
  }
}

export function elicitResultToAGUIResume(
  interruptId: string,
  result: RawElicitResult,
): AGUIResume {
  if (result.action === 'accept') {
    return { interruptId, status: 'resolved', payload: result.content }
  }
  return { interruptId, status: 'cancelled' }
}

export function aguiResumeToElicitResult(resume: AGUIResume): RawElicitResult {
  if (resume.status === 'resolved') {
    return { action: 'accept', content: resume.payload }
  }
  return { action: 'cancel' }
}

export type A2ATaskState =
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_CANCELED'

export interface A2AInterruptedTaskStatus {
  state: 'TASK_STATE_INPUT_REQUIRED' | 'TASK_STATE_AUTH_REQUIRED'
  contextId?: string
  taskId?: string
  metadata: {
    interruptId: string
    key: string
    reason: string
    message: string
    responseSchema?: unknown
    contextSchema?: unknown
    context?: unknown
    toolCallId?: string
    expiresAt?: string
  }
}

export interface A2ACancelTaskProjection {
  method: 'CancelTask'
  state: 'TASK_STATE_CANCELED'
  contextId?: string
  taskId?: string
  reason?: string
}

export function toA2AInterruptedTaskStatus(
  interrupt: InterruptDescriptor,
  ids: { contextId?: string; taskId?: string } = {},
): A2AInterruptedTaskStatus {
  const state = isAuthReason(interrupt.reason)
    ? 'TASK_STATE_AUTH_REQUIRED'
    : 'TASK_STATE_INPUT_REQUIRED'
  return {
    state,
    ...(ids.contextId !== undefined ? { contextId: ids.contextId } : {}),
    ...(ids.taskId !== undefined ? { taskId: ids.taskId } : {}),
    metadata: {
      interruptId: interrupt.id,
      key: interrupt.key,
      reason: interrupt.reason,
      message: interrupt.message,
      ...(interrupt.responseSchema !== undefined ? { responseSchema: interrupt.responseSchema } : {}),
      ...(interrupt.contextSchema !== undefined ? { contextSchema: interrupt.contextSchema } : {}),
      ...(interrupt.context !== undefined ? { context: interrupt.context } : {}),
      ...(interrupt.toolCallId !== undefined ? { toolCallId: interrupt.toolCallId } : {}),
      ...(interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : {}),
    },
  }
}

export function toA2ACancelTaskProjection(
  ids: { contextId?: string; taskId?: string; reason?: string } = {},
): A2ACancelTaskProjection {
  return {
    method: 'CancelTask',
    state: 'TASK_STATE_CANCELED',
    ...(ids.contextId !== undefined ? { contextId: ids.contextId } : {}),
    ...(ids.taskId !== undefined ? { taskId: ids.taskId } : {}),
    ...(ids.reason !== undefined ? { reason: ids.reason } : {}),
  }
}

function isAuthReason(reason: string): boolean {
  return reason === 'auth' || reason === 'auth_required' || reason.endsWith(':auth') || reason.endsWith(':auth_required')
}
