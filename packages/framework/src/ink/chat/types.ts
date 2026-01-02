/**
 * ink/chat/types.ts
 *
 * Type definitions for the Ink chat adapter.
 * These types mirror the React adapter but with terminal-specific output.
 */

import type { ComponentType } from 'react'
import type { Frame } from '../../react/chat/pipeline'
import type {
  ChatMessage as BaseChatMessage,
  ChatToolCall as BaseChatToolCall,
  ChatEmission as BaseChatEmission,
  StreamingMessage as BaseStreamingMessage,
  MessagePart,
} from '../../lib/chat/types/chat-message'
import type { ChatState, PendingClientToolState, ToolEmissionTrackingState } from '../../lib/chat/state'
import type { PendingHandoffState } from '../../lib/chat/patches/handoff'
import type { PendingHandoff } from '../../lib/chat/isomorphic-tools'

// =============================================================================
// INK-SPECIFIC TYPE ALIASES
// =============================================================================

/**
 * A tool emission with Ink component type.
 * Ink uses React components, so this is the same as React.
 */
export type InkChatEmission = BaseChatEmission<ComponentType<any>>

/**
 * A tool call with Ink component type for emissions.
 */
export type InkChatToolCall = BaseChatToolCall<ComponentType<any>>

/**
 * A chat message with Ink component type for emissions.
 */
export type InkChatMessage = BaseChatMessage<ComponentType<any>>

/**
 * Streaming message with Ink component type for tool calls.
 */
export type InkStreamingMessage = BaseStreamingMessage<ComponentType<any>>

// =============================================================================
// RE-EXPORTS FOR CONVENIENCE
// =============================================================================

export type {
  Frame,
  MessagePart,
  ChatState,
  PendingClientToolState,
  PendingHandoffState,
  ToolEmissionTrackingState,
  PendingHandoff,
}
