/**
 * Internal agent handle — the seam between `createAgent` (which owns the
 * `createApi` surface + invocation context) and `driveEntry` (which builds the
 * per-run `AgentCtx` and kicks off the invocation).
 *
 * Kept behind a Symbol so the public `AgentFactory` interface stays clean.
 */

import type { Operation } from 'effection'

import type { AgentCtx, RequestRouter, SampleProvider } from './ctx.ts'
import type { AgentStream } from './stream.ts'
import type { AgentMessage, AgentState } from './events.ts'

/** Options for an internal run (mirrors DriveOptions). */
export interface RunOptions {
  stream: AgentStream
  subSessionId: string | undefined
  router: RequestRouter
  sampleProvider: SampleProvider | undefined
  messages: AgentMessage[]
  state: AgentState
}

export const AGENT_RUN = Symbol('agent.run')

/** The internal run function attached to every AgentFactory. */
export type AgentRunFn = (input: unknown, opts: RunOptions) => Operation<unknown>

export interface AgentInternal {
  [AGENT_RUN]: AgentRunFn
}

/** Type-only accessor for the internal run handle. */
export function getRun(agent: unknown): AgentRunFn {
  const run = (agent as AgentInternal)[AGENT_RUN]
  if (!run) {
    throw new Error(
      `Agent is not an @sweatpants/agents AgentFactory (missing internal run handle). ` +
        `Did you pass a @sweatpants/core createAgent result by mistake?`,
    )
  }
  return run
}

export type { AgentCtx }
