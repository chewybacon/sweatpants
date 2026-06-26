/**
 * AgentCommand — operations participants append to the stream.
 *
 * (Spec REQ-007: sendMessage, respondElicit, respondSample, and cancel are
 * append-operations onto the stream, not direct RPC calls into a coroutine.)
 */

import type { AgentLogEntryTag } from './log.ts'
import type { IncomingElicitResponse, SampleResult } from './events.ts'

export interface SendMessageCommand {
  type: 'sendMessage'
  /**
   * Server-stateful: the durable stream id. When present and the server has a
   * stream for it, restoration uses the latest checkpoint (REQ-012 path 1).
   */
  contextId?: string
  /**
   * Stateless: a client-carried checkpoint. When present (and contextId is
   * absent or the server lacks it), restoration seeds from the snapshot
   * (REQ-012 path 2).
   */
  snapshot?: unknown
  /** The new user message (also the entry harness input). */
  message: string
  /** Optional explicit message id (one is generated if absent). */
  messageId?: string
}

export interface RespondElicitCommand {
  type: 'respondElicit'
  requestId: string
  result: IncomingElicitResponse
}

export interface RespondSampleCommand {
  type: 'respondSample'
  requestId: string
  result: SampleResult
}

export interface CancelCommand {
  type: 'cancel'
  reason?: string
}

export type AgentCommand =
  | SendMessageCommand
  | RespondElicitCommand
  | RespondSampleCommand
  | CancelCommand

/** Shape appended to the log (carries lsn + timestamp assigned by the stream). */
export type AgentCommandEntry = AgentCommand & AgentLogEntryTag & {
  lsn: number
  timestamp: number
}
