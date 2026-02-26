/**
 * lib/chat/state/reducer.ts
 *
 * Pure reducer for chat state. Framework-agnostic - can be used with
 * React, Vue, Svelte, or any state management system.
 *
 * ## Parts-Based Model
 *
 * The reducer handles a parts-based streaming model:
 * - streaming_text → TextPart
 * - streaming_reasoning → ReasoningPart
 * - tool_call_start → ToolCallPart
 * - part_frame → Updates a part's Frame
 *
 * When content type switches, the current part is finalized and a new one starts.
 */
import type { ChatState, ToolEmissionState, ToolEmissionTrackingState, ElicitState, ElicitTrackingState } from './chat-state.ts'
import { initialChatState } from './chat-state.ts'
import type { ChatPatch } from '../patches/index.ts'
import { reduceCore } from './reducers/core-reducer.ts'
import { reduceStreamingParts } from './reducers/streaming-parts-reducer.ts'
import { reduceClientTools } from './reducers/client-tools-reducer.ts'
import { reduceElicits } from './reducers/elicit-reducer.ts'
import { reduceToolEmissions } from './reducers/tool-emissions-reducer.ts'

// Re-export types for convenience
export type { ChatState, ToolEmissionState, ToolEmissionTrackingState, ElicitState, ElicitTrackingState }
export { initialChatState }

// =============================================================================
// REDUCER
// =============================================================================

/**
 * Apply a patch to the chat state (pure reducer).
 *
 * Uses a parts-based model:
 * - streaming.parts accumulates parts as content streams in
 * - streaming.activePartId tracks the currently active part
 * - Part type switches create new parts
 */
export function chatReducer(state: ChatState, patch: ChatPatch): ChatState {
  const coreState = reduceCore(state, patch)
  if (coreState) return coreState

  const streamingState = reduceStreamingParts(state, patch)
  if (streamingState) return streamingState

  const clientToolsState = reduceClientTools(state, patch)
  if (clientToolsState) return clientToolsState

  const elicitState = reduceElicits(state, patch)
  if (elicitState) return elicitState

  const toolEmissionsState = reduceToolEmissions(state, patch)
  if (toolEmissionsState) return toolEmissionsState

  return state
}
