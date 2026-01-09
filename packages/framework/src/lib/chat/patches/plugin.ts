/**
 * lib/chat/patches/plugin.ts
 *
 * Patch types for MCP plugin tool elicitation.
 * These patches handle the client-side UI for plugin tools that need user input.
 */

// =============================================================================
// PLUGIN ELICITATION STATE
// =============================================================================

/**
 * State of a pending plugin elicitation request.
 */
export interface PluginElicitState {
  /** Unique elicitation ID */
  elicitId: string

  /** Session ID for the plugin session */
  sessionId: string

  /** Tool call ID this elicitation belongs to */
  callId: string

  /** Name of the plugin tool */
  toolName: string

  /** Elicitation key (e.g., 'pickFlight', 'pickSeat') */
  key: string

  /** Human-readable message for the user */
  message: string

  /** JSON schema for the expected response */
  schema: Record<string, unknown>

  /** Context data extracted from x-model-context */
  context?: unknown

  /** Current status */
  status: 'pending' | 'responded' | 'cancelled'

  /** Response value once user has responded */
  response?: unknown

  /** Timestamp for ordering */
  timestamp: number
}

/**
 * State tracking plugin elicitations for a tool call.
 */
export interface PluginElicitTrackingState {
  /** Tool call ID */
  callId: string

  /** Tool name */
  toolName: string

  /** All pending elicitations for this tool call */
  elicitations: PluginElicitState[]

  /** Overall status */
  status: 'running' | 'awaiting_elicit' | 'complete' | 'error' | 'cancelled'

  /** Start timestamp */
  startedAt: number
}

// =============================================================================
// PLUGIN ELICITATION PATCHES
// =============================================================================

/**
 * Patch: Plugin elicitation started for a tool call.
 */
export interface PluginElicitStartPatch {
  type: 'plugin_elicit_start'
  callId: string
  toolName: string
}

/**
 * Patch: New plugin elicitation request.
 */
export interface PluginElicitPatch {
  type: 'plugin_elicit'
  callId: string
  elicit: Omit<PluginElicitState, 'callId' | 'toolName'>
}

/**
 * Patch: User responded to a plugin elicitation.
 */
export interface PluginElicitResponsePatch {
  type: 'plugin_elicit_response'
  callId: string
  elicitId: string
  response: unknown
}

/**
 * Patch: Plugin elicitation complete (all elicitations for a call done).
 */
export interface PluginElicitCompletePatch {
  type: 'plugin_elicit_complete'
  callId: string
}

/**
 * Union of all plugin elicitation patches.
 */
export type PluginElicitPatchUnion =
  | PluginElicitStartPatch
  | PluginElicitPatch
  | PluginElicitResponsePatch
  | PluginElicitCompletePatch
