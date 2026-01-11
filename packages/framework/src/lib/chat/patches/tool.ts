/**
 * lib/chat/patches/tool.ts
 *
 * Tool-related patches for client tools and isomorphic tools.
 */

import type { AuthorityMode, IsomorphicToolState } from '../core-types.ts'

// =============================================================================
// CLIENT TOOL PATCHES
// =============================================================================

/**
 * Emitted when a client tool is waiting for user approval.
 */
export interface ClientToolAwaitingApprovalPatch {
  type: 'client_tool_awaiting_approval'
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Message to display in approval dialog */
  message: string
}

/**
 * Emitted when a client tool starts executing (after approval).
 */
export interface ClientToolExecutingPatch {
  type: 'client_tool_executing'
  /** Tool call ID */
  id: string
}

/**
 * Emitted when a client tool completes successfully.
 */
export interface ClientToolCompletePatch {
  type: 'client_tool_complete'
  /** Tool call ID */
  id: string
  /** Tool result (serialized to string) */
  result: string
}

/**
 * Emitted when a client tool encounters an error.
 */
export interface ClientToolErrorPatch {
  type: 'client_tool_error'
  /** Tool call ID */
  id: string
  /** Error message */
  error: string
}

/**
 * Emitted when a client tool is denied by the user.
 */
export interface ClientToolDeniedPatch {
  type: 'client_tool_denied'
  /** Tool call ID */
  id: string
  /** Reason for denial */
  reason: string
}

/**
 * Emitted when a client tool reports progress.
 */
export interface ClientToolProgressPatch {
  type: 'client_tool_progress'
  /** Tool call ID */
  id: string
  /** Progress message */
  message: string
}

/**
 * Emitted when a client tool needs browser permission.
 */
export interface ClientToolPermissionRequestPatch {
  type: 'client_tool_permission_request'
  /** Tool call ID */
  id: string
  /** Type of permission needed */
  permissionType: string
}

/**
 * Client tool patches - for browser-side tool execution.
 */
export type ClientToolPatch =
  | ClientToolAwaitingApprovalPatch
  | ClientToolExecutingPatch
  | ClientToolCompletePatch
  | ClientToolErrorPatch
  | ClientToolDeniedPatch
  | ClientToolProgressPatch
  | ClientToolPermissionRequestPatch

// =============================================================================
// ISOMORPHIC TOOL PATCHES
// =============================================================================

/**
 * Emitted when an isomorphic tool's state changes.
 */
export interface IsomorphicToolStatePatch {
  type: 'isomorphic_tool_state'
  /** Tool call ID */
  id: string
  /** Current state */
  state: IsomorphicToolState
  /** Authority mode */
  authority: AuthorityMode
  /** Server output (if available) */
  serverOutput?: unknown
  /** Client output (if available) */
  clientOutput?: unknown
  /** Error message (if failed) */
  error?: string
}

/**
 * Isomorphic tool patches.
 */
export type IsomorphicToolPatch = IsomorphicToolStatePatch
