/**
 * AgentLogEntry — the durable stream's append unit: an event OR a command.
 *
 * Both share the stream (Spec REQ-007: commands are append-operations). This
 * module owns the union and the tag/guards to keep events.ts and commands.ts
 * free of a circular import.
 */

import type { AgentEvent } from './events.ts'
import type { AgentCommandEntry } from './commands.ts'

/** Tag carried by commands so they can be distinguished from events. */
export interface AgentLogEntryTag {
  command: true
}

export type AgentLogEntry = AgentEvent | AgentCommandEntry

export function isAgentEvent(entry: AgentLogEntry): entry is AgentEvent {
  return !('command' in entry) || (entry as { command?: unknown }).command !== true
}

export function isCommand(entry: AgentLogEntry): entry is AgentCommandEntry {
  return (
    'command' in entry && (entry as { command?: unknown }).command === true
  )
}
