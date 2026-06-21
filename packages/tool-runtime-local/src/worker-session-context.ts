/**
 * Worker Session Context
 *
 * Provides context access to worker session state for API operations.
 */

import { createContext, type Channel, type Operation } from 'effection'
import type { RawElicitResult } from '@sweatpants/framework/chat/mcp-tools'
import type { ToolSessionEvent, ToolSessionStatus, RawSampleResult } from '@sweatpants/framework/chat/mcp-tools'

export interface WorkerSessionState {
  /** Pending elicit channels, keyed by elicitId */
  pendingElicitChannels: Map<string, Channel<RawElicitResult<unknown>, void>>

  /** Pending sample channels, keyed by sampleId */
  pendingSampleChannels: Map<string, Channel<RawSampleResult, void>>

  /** Emit a session event (adds LSN/timestamp internally) */
  emitEvent(event: { type: ToolSessionEvent['type'] } & Record<string, unknown>): Operation<void>

  /** Generate the next LSN */
  nextLsn(): number

  /** Update session status */
  setStatus(status: ToolSessionStatus): void
}

export const WorkerSessionStateContext = createContext<WorkerSessionState>(
  'worker-session.state'
)
