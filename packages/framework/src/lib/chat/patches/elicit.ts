/**
 * lib/chat/patches/elicit.ts
 *
 * Patch types for tool elicitation.
 * These patches handle the client-side UI for tools that need user input.
 * 
 * This is the unified elicitation system used by both MCP tools and isomorphic tools.
 */

// =============================================================================
// ELICITATION STATE
// =============================================================================

/**
 * State of a pending elicitation request.
 */
export interface ElicitState {
  /** Unique elicitation ID */
  elicitId: string

  /** Session ID for the tool session */
  sessionId: string

  /** Tool call ID this elicitation belongs to */
  callId: string

  /** Name of the tool */
  toolName: string

  /** Elicitation key (e.g., 'pickFlight', 'pickSeat', '__handoff__') */
  key: string

  /** Human-readable message for the user */
  message: string

  /** JSON schema for the expected response */
  schema: Record<string, unknown>

  /** Context data for the elicitation */
  context?: unknown

  /** Current status */
  status: 'pending' | 'responded' | 'cancelled'

  /** Response value once user has responded */
  response?: unknown

  /** Timestamp for ordering */
  timestamp: number
}

/**
 * State tracking elicitations for a tool call.
 */
export interface ElicitTrackingState {
  /** Tool call ID */
  callId: string

  /** Tool name */
  toolName: string

  /** All pending elicitations for this tool call */
  elicitations: ElicitState[]

  /** Overall status */
  status: 'running' | 'awaiting_elicit' | 'complete' | 'error' | 'cancelled'

  /** Start timestamp */
  startedAt: number
}

// =============================================================================
// ELICITATION PATCHES
// =============================================================================

/**
 * Patch: Elicitation started for a tool call.
 */
export interface ElicitStartPatch {
  type: 'elicit_start'
  callId: string
  toolName: string
}

/**
 * Patch: New elicitation request.
 */
export interface ElicitPatch {
  type: 'elicit'
  callId: string
  elicit: Omit<ElicitState, 'callId' | 'toolName'>
}

/**
 * Patch: User responded to an elicitation.
 */
export interface ElicitResponsePatch {
  type: 'elicit_response'
  callId: string
  elicitId: string
  response: unknown
}

/**
 * Patch: Elicitation complete (all elicitations for a call done).
 */
export interface ElicitCompletePatch {
  type: 'elicit_complete'
  callId: string
}

/**
 * Union of all elicitation patches.
 */
export type ElicitPatchUnion =
  | ElicitStartPatch
  | ElicitPatch
  | ElicitResponsePatch
  | ElicitCompletePatch

// =============================================================================
// LEGACY ALIASES (for migration)
// =============================================================================

/** @deprecated Use ElicitState instead */
export type PluginElicitState = ElicitState

/** @deprecated Use ElicitTrackingState instead */
export type PluginElicitTrackingState = ElicitTrackingState

/** @deprecated Use ElicitStartPatch instead */
export type PluginElicitStartPatch = ElicitStartPatch

/** @deprecated Use ElicitPatch instead */
export type PluginElicitPatch = ElicitPatch

/** @deprecated Use ElicitResponsePatch instead */
export type PluginElicitResponsePatch = ElicitResponsePatch

/** @deprecated Use ElicitCompletePatch instead */
export type PluginElicitCompletePatch = ElicitCompletePatch

/** @deprecated Use ElicitPatchUnion instead */
export type PluginElicitPatchUnion = ElicitPatchUnion
