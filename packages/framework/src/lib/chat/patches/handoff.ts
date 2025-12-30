/**
 * lib/chat/patches/handoff.ts
 *
 * Handoff and execution trail patches.
 * These support the ctx.render() and tool handoff patterns.
 */

import type { AuthorityMode } from '../core-types'

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

// =============================================================================
// EXECUTION TRAIL PATCHES
// =============================================================================

/**
 * Step data within an execution trail.
 */
export interface ExecutionTrailStepData {
  id: string
  kind: 'emit' | 'prompt'
  type?: string
  payload?: unknown
  /** React element for render steps (serialized or reference) */
  element?: unknown
  /** React component for factory pattern (ctx.step) */
  component?: unknown
  timestamp: number
  status: 'pending' | 'complete'
  response?: unknown
}

/**
 * Emitted when a step-enabled tool starts execution.
 */
export interface ExecutionTrailStartPatch {
  type: 'execution_trail_start'
  /** The tool call ID */
  callId: string
  /** The tool name */
  toolName: string
}

/**
 * Emitted when a step is produced by a tool.
 */
export interface ExecutionTrailStepPatch {
  type: 'execution_trail_step'
  /** The tool call ID */
  callId: string
  /** The step data */
  step: ExecutionTrailStepData
  /** Respond function (only for prompts) - React should call this */
  respond?: (response: unknown) => void
}

/**
 * Emitted when a step-enabled tool completes execution.
 */
export interface ExecutionTrailCompletePatch {
  type: 'execution_trail_complete'
  /** The tool call ID */
  callId: string
  /** The final result */
  result?: unknown
  /** Error if failed */
  error?: string
}

/**
 * Emitted when a step receives a response.
 */
export interface ExecutionTrailStepResponsePatch {
  type: 'execution_trail_step_response'
  /** The step ID that received a response */
  stepId: string
  /** The tool call ID this step belongs to */
  callId: string
  /** The response value */
  response: unknown
}

/**
 * Execution trail patches - for ctx.render() pattern.
 */
export type ExecutionTrailPatch =
  | ExecutionTrailStartPatch
  | ExecutionTrailStepPatch
  | ExecutionTrailCompletePatch
  | ExecutionTrailStepResponsePatch
