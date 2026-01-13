/**
 * lib/chat/patches/index.ts
 *
 * Unified patch types for the chat system.
 * Patches are messages sent from the session layer to React state.
 */

// Re-export all patch types
export type {
  // Content part types
  ContentPartType,
  // Core patches
  SessionInfoPatch,
  UserMessagePatch,
  AssistantMessagePatch,
  StreamingStartPatch,
  StreamingTextPatch,
  StreamingReasoningPatch,
  StreamingEndPatch,
  PartFramePatch,
  PartEndPatch,
  ToolCallStartPatch,
  ToolCallResultPatch,
  ToolCallErrorPatch,
  AbortCompletePatch,
  ErrorPatch,
  ResetPatch,
  CorePatch,
} from './base.ts'

export type {
  // Buffer patches
  BufferSettledPatch,
  BufferPendingPatch,
  BufferRawPatch,
  BufferRenderablePatch,
  BufferPatch,
} from './buffer.ts'

export type {
  // Client tool patches
  ClientToolAwaitingApprovalPatch,
  ClientToolExecutingPatch,
  ClientToolCompletePatch,
  ClientToolErrorPatch,
  ClientToolDeniedPatch,
  ClientToolProgressPatch,
  ClientToolPermissionRequestPatch,
  ClientToolPatch,
  // Isomorphic tool patches
  IsomorphicToolStatePatch,
  IsomorphicToolPatch,
} from './tool.ts'

export type {
  // Handoff patches
  PendingHandoffState,
  PendingHandoffPatch,
  HandoffCompletePatch,
  HandoffPatch,
  // Execution trail patches
  ExecutionTrailStepData,
  ExecutionTrailStartPatch,
  ExecutionTrailStepPatch,
  ExecutionTrailCompletePatch,
  ExecutionTrailStepResponsePatch,
  ExecutionTrailPatch,
} from './handoff.ts'

export type {
  // Emission patches (new ctx.render() pattern)
  ToolEmissionState,
  ToolEmissionTrackingState,
  ToolEmissionStartPatch,
  ToolEmissionPatch,
  ToolEmissionResponsePatch,
  ToolEmissionCompletePatch,
  EmissionPatch,
} from './emission.ts'

export type {
  // Plugin elicitation patches (MCP plugin tools)
  PluginElicitState,
  PluginElicitTrackingState,
  PluginElicitStartPatch,
  PluginElicitPatch,
  PluginElicitResponsePatch,
  PluginElicitCompletePatch,
  PluginElicitPatchUnion,
} from './plugin.ts'

// Import for union type construction
import type { CorePatch } from './base.ts'
import type { BufferPatch } from './buffer.ts'
import type { ClientToolPatch, IsomorphicToolPatch } from './tool.ts'
import type { HandoffPatch, ExecutionTrailPatch } from './handoff.ts'
import type { EmissionPatch } from './emission.ts'
import type { PluginElicitPatchUnion } from './plugin.ts'

/**
 * All chat patches - the complete union of all patch types.
 *
 * Organized into categories for better maintainability:
 * - CorePatch: Session lifecycle, messages, streaming, errors
 * - BufferPatch: Dual-buffer rendering (settled/pending/raw/renderable)
 * - ClientToolPatch: Browser-side tool execution
 * - IsomorphicToolPatch: Server+client tool state
 * - HandoffPatch: Tool handoff to React UI
 * - ExecutionTrailPatch: ctx.render() pattern steps (legacy)
 * - EmissionPatch: Tool emissions (new ctx.render() pattern)
 * - PluginElicitPatchUnion: MCP plugin tool elicitation
 */
export type ChatPatch =
  | CorePatch
  | BufferPatch
  | ClientToolPatch
  | IsomorphicToolPatch
  | HandoffPatch
  | ExecutionTrailPatch
  | EmissionPatch
  | PluginElicitPatchUnion

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if a patch is a core patch.
 */
export function isCorePatch(patch: ChatPatch): patch is CorePatch {
  return [
    'session_info',
    'user_message',
    'assistant_message',
    'streaming_start',
    'streaming_text',
    'streaming_reasoning',
    'streaming_end',
    'part_frame',
    'part_end',
    'tool_call_start',
    'tool_call_result',
    'tool_call_error',
    'abort_complete',
    'error',
    'reset',
  ].includes(patch.type)
}

/**
 * Check if a patch is a buffer patch.
 */
export function isBufferPatch(patch: ChatPatch): patch is BufferPatch {
  return [
    'buffer_settled',
    'buffer_pending',
    'buffer_raw',
    'buffer_renderable',
  ].includes(patch.type)
}

/**
 * Check if a patch is a client tool patch.
 */
export function isClientToolPatch(patch: ChatPatch): patch is ClientToolPatch {
  return [
    'client_tool_awaiting_approval',
    'client_tool_executing',
    'client_tool_complete',
    'client_tool_error',
    'client_tool_denied',
    'client_tool_progress',
    'client_tool_permission_request',
  ].includes(patch.type)
}

/**
 * Check if a patch is an isomorphic tool patch.
 */
export function isIsomorphicToolPatch(patch: ChatPatch): patch is IsomorphicToolPatch {
  return patch.type === 'isomorphic_tool_state'
}

/**
 * Check if a patch is a handoff patch.
 */
export function isHandoffPatch(patch: ChatPatch): patch is HandoffPatch {
  return ['pending_handoff', 'handoff_complete'].includes(patch.type)
}

/**
 * Check if a patch is an execution trail patch.
 */
export function isExecutionTrailPatch(patch: ChatPatch): patch is ExecutionTrailPatch {
  return [
    'execution_trail_start',
    'execution_trail_step',
    'execution_trail_complete',
    'execution_trail_step_response',
  ].includes(patch.type)
}

/**
 * Check if a patch is an emission patch.
 */
export function isEmissionPatch(patch: ChatPatch): patch is EmissionPatch {
  return [
    'tool_emission_start',
    'tool_emission',
    'tool_emission_response',
    'tool_emission_complete',
  ].includes(patch.type)
}

/**
 * Check if a patch is a plugin elicit patch.
 */
export function isPluginElicitPatch(patch: ChatPatch): patch is PluginElicitPatchUnion {
  return [
    'plugin_elicit_start',
    'plugin_elicit',
    'plugin_elicit_response',
    'plugin_elicit_complete',
  ].includes(patch.type)
}
