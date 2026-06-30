/**
 * lib/chat/patches/index.ts
 */

export type {
  ContentPartType,
  SessionInfoPatch,
  UserMessagePatch,
  HistoryMessagePatch,
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
  BufferSettledPatch,
  BufferPendingPatch,
  BufferRawPatch,
  BufferRenderablePatch,
  BufferPatch,
} from './buffer.ts'

export type {
  ClientToolAwaitingApprovalPatch,
  ClientToolExecutingPatch,
  ClientToolCompletePatch,
  ClientToolErrorPatch,
  ClientToolDeniedPatch,
  ClientToolProgressPatch,
  ClientToolPermissionRequestPatch,
  ClientToolPatch,
} from './tool.ts'

export type {
  ToolEmissionState,
  ToolEmissionTrackingState,
  ToolEmissionStartPatch,
  ToolEmissionPatch,
  ToolEmissionResponsePatch,
  ToolEmissionCompletePatch,
  EmissionPatch,
} from './emission.ts'

export type {
  ElicitState,
  ElicitTrackingState,
  ElicitStartPatch,
  ElicitPatch,
  ElicitResponsePatch,
  ElicitCompletePatch,
  ElicitPatchUnion,
} from './elicit.ts'

import type { CorePatch } from './base.ts'
import type { BufferPatch } from './buffer.ts'
import type { ClientToolPatch } from './tool.ts'
import type { EmissionPatch } from './emission.ts'
import type { ElicitPatchUnion } from './elicit.ts'

export type ChatPatch =
  | CorePatch
  | BufferPatch
  | ClientToolPatch
  | EmissionPatch
  | ElicitPatchUnion

export function isCorePatch(patch: ChatPatch): patch is CorePatch {
  return [
    'session_info',
    'user_message',
    'history_message',
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

export function isBufferPatch(patch: ChatPatch): patch is BufferPatch {
  return [
    'buffer_settled',
    'buffer_pending',
    'buffer_raw',
    'buffer_renderable',
  ].includes(patch.type)
}

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

export function isEmissionPatch(patch: ChatPatch): patch is EmissionPatch {
  return [
    'tool_emission_start',
    'tool_emission',
    'tool_emission_response',
    'tool_emission_complete',
  ].includes(patch.type)
}

export function isElicitPatch(patch: ChatPatch): patch is ElicitPatchUnion {
  return [
    'elicit_start',
    'elicit',
    'elicit_response',
    'elicit_complete',
  ].includes(patch.type)
}
