/**
 * lib/chat/patches/handoff.ts
 *
 * Handoff patches for tool handoff pattern.
 */

import type { AuthorityMode } from '../core-types.ts'

// =============================================================================
// HANDOFF PATCHES
// =============================================================================

/**
 * A pending handoff waiting for React UI to respond.
 */
export interface PendingHandoffState {
  /** Unique identifier for this tool call */
  callId: string
  /** The tool name */
  toolName: string
  /** The params passed to the tool */
  params: unknown
  /** The handoff data (from before() or server output) */
  data: unknown
  /** The authority mode of the tool */
  authority: AuthorityMode
  /** Whether this tool uses the V7 handoff pattern */
  usesHandoff: boolean
}

/**
 * Emitted when a tool is waiting for React UI to handle it.
 */
export interface PendingHandoffPatch {
  type: 'pending_handoff'
  /** The handoff to add to pending state */
  handoff: PendingHandoffState
}

/**
 * Emitted when a React handler responds to a handoff.
 */
export interface HandoffCompletePatch {
  type: 'handoff_complete'
  /** The tool call ID */
  callId: string
}

/**
 * Handoff patches.
 */
export type HandoffPatch = PendingHandoffPatch | HandoffCompletePatch
