/**
 * Local fulfillment driver — runs an agent's `entry` harness as a generator,
 * constructing its `AgentCtx` and fulfilling `ctx.call` isomorphically for
 * local tools and sub-agents (Spec REQ-003/006/009).
 *
 * Remote handles (A2A/agentcore) error clearly here; stage 2 wires transports.
 */

import type { Operation } from 'effection'

import type { AgentFactory } from './types.ts'
import type {
  AgentCheckpoint,
  AgentEvent,
  AgentMessage,
  AgentState,
} from './events.ts'
import type { AgentStream } from './stream.ts'
import { effectiveSystemPrompt, type RequestRouter, type SampleProvider } from './ctx.ts'
import { getRun } from './internal.ts'

export interface DriveOptions {
  stream: AgentStream
  /** This run's subSessionId (undefined for the root harness). */
  subSessionId: string | undefined
  router: RequestRouter
  sampleProvider: SampleProvider | undefined
  messages: AgentMessage[]
  state: AgentState
}

export function* driveEntry(
  agent: AgentFactory<any, any, any, any>,
  input: unknown,
  opts: DriveOptions,
): Operation<unknown> {
  // Dispatch through the agent's createApi surface (agent middleware composes
  // via `api.around`). The agent owns its `run` which builds the AgentCtx and
  // installs it in the invocation context before calling `api.invoke`.
  const run = getRun(agent)
  return yield* run(input, {
    stream: opts.stream,
    subSessionId: opts.subSessionId,
    router: opts.router,
    sampleProvider: opts.sampleProvider,
    messages: opts.messages,
    state: opts.state,
  })
}

// ============================================================================
// Checkpoint emit / restore (Spec REQ-011/013)
// ============================================================================

interface CheckpointEvent {
  type: 'checkpoint'
  lsn: number
  checkpoint: AgentCheckpoint
}

/** Emit a checkpoint event capturing harness state; index it for O(1) restore. */
export function* emitCheckpointOp(
  stream: AgentStream,
  contextId: string,
  messages: AgentMessage[],
  state: AgentState,
): Operation<void> {
  const checkpoint: AgentCheckpoint = {
    contextId,
    atLsn: -1,
    messages: messages.map((m) => ({ ...m, content: [...m.content] })),
    pendingInterruptIds: [],
    pendingSubSessions: [],
    pendingRequests: [],
    state: { ...state },
  }
  const appended = (yield* stream.append({
    type: 'checkpoint',
    checkpoint,
  } as AgentEvent)) as CheckpointEvent
  checkpoint.atLsn = appended.lsn
  stream.recordCheckpoint(appended.lsn)
}

/**
 * Restore harness state from the latest checkpoint for the stream, if any.
 * Returns the restored messages/state (or null if none). (Spec REQ-011.)
 */
export function* restoreFromCheckpoint(
  stream: AgentStream,
): Operation<{ messages: AgentMessage[]; state: AgentState; atLsn: number } | null> {
  const lsn = stream.latestCheckpointLsn()
  if (lsn === undefined) return null
  const { entries } = yield* stream.readEntries(lsn)
  for (const entry of entries) {
    if (entry.type === 'checkpoint') {
      const cp = (entry as CheckpointEvent).checkpoint
      return {
        messages: cp.messages.map((m) => ({ ...m })),
        state: { ...cp.state },
        atLsn: lsn,
      }
    }
  }
  return null
}

export { effectiveSystemPrompt }
