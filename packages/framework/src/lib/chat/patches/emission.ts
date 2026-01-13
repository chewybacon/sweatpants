/**
 * lib/chat/patches/emission.ts
 *
 * Patch types for tool emissions (ctx.render() pattern).
 */

import type { ComponentEmissionPayload, ToolExecutionTrace } from '../isomorphic-tools/runtime/emissions.ts'

// =============================================================================
// EMISSION STATE
// =============================================================================

/**
 * State of a pending tool emission in React.
 */
export interface ToolEmissionState {
  /** Unique emission ID */
  id: string

  /** Tool call ID this emission belongs to */
  callId: string

  /** Tool name */
  toolName: string

  /** Emission type (usually '__component__') */
  type: string

  /** Serializable payload (component key + props) */
  payload: ComponentEmissionPayload

  /** Current status */
  status: 'pending' | 'complete' | 'error'

  /** Response value once complete */
  response?: unknown

  /** Error message if failed */
  error?: string

  /** Timestamp for ordering */
  timestamp: number

  /**
   * Respond callback - call this to complete the emission.
   * Only present for pending emissions.
   */
  respond?: (response: unknown) => void
}

/**
 * State tracking emissions for a tool call.
 */
export interface ToolEmissionTrackingState {
  /** Tool call ID */
  callId: string

  /** Tool name */
  toolName: string

  /** All emissions in order */
  emissions: ToolEmissionState[]

  /** Overall status */
  status: 'running' | 'complete' | 'error' | 'cancelled'

  /** Start timestamp */
  startedAt: number

  /** End timestamp (when complete/error/cancelled) */
  completedAt?: number

  /** Final result (when complete) */
  result?: unknown

  /** Error message (when error) */
  error?: string
}

// =============================================================================
// EMISSION PATCHES
// =============================================================================

/**
 * Patch: Tool emission execution started.
 * Creates a new emission tracking state for a tool call.
 */
export interface ToolEmissionStartPatch {
  type: 'tool_emission_start'
  callId: string
  toolName: string
}

/**
 * Patch: New emission from a tool.
 * Adds an emission to the tracking state.
 */
export interface ToolEmissionPatch {
  type: 'tool_emission'
  callId: string
  /** Tool name (optional, for auto-creating tracking if start patch is delayed) */
  toolName?: string
  emission: Omit<ToolEmissionState, 'callId' | 'toolName'>
  /** Respond callback for pending emissions */
  respond?: (response: unknown) => void
}

/**
 * Patch: Emission response received.
 * Updates emission status and removes respond callback.
 */
export interface ToolEmissionResponsePatch {
  type: 'tool_emission_response'
  callId: string
  emissionId: string
  response: unknown
}

/**
 * Patch: Tool emission execution completed.
 * Finalizes the emission tracking state.
 */
export interface ToolEmissionCompletePatch {
  type: 'tool_emission_complete'
  callId: string
  result?: unknown
  error?: string
  /** The final trace for the tool message */
  trace?: ToolExecutionTrace
}

/**
 * Union of all emission patches.
 */
export type EmissionPatch =
  | ToolEmissionStartPatch
  | ToolEmissionPatch
  | ToolEmissionResponsePatch
  | ToolEmissionCompletePatch
