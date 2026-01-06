/**
 * lib/chat/session/index.ts
 *
 * Session runtime and types for the chat system.
 * Framework-agnostic - can be used with React, Vue, Svelte, etc.
 */

// Session runtime
export {
  createChatSession,
  runChatSession,
} from './create-session'

export type {
  ChatSession,
  ClientToolSessionOptions,
  HandoffResponseSignalValue,
} from './create-session'

// Streaming
export { streamChatOnce, toApiMessages } from './stream-chat'
export type { StreamChatOptions } from './stream-chat'

// Transforms
export {
  useTransformPipeline,
  passthroughTransform,
  loggingTransform,
} from './transforms'

// Contexts
export {
  BaseUrlContext,
  StreamerContext,
  ToolRegistryContext,
} from './contexts'

// Streaming types
export type {
  ApiMessage,
  ConversationState,
  StreamResult,
  StreamCompleteResult,
  StreamIsomorphicHandoffResult,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  StreamEvent,
} from './streaming'

// Options and configuration
export type {
  Streamer,
  MessageRenderer,
  PatchTransform,
  SessionOptions,
  ChatCommand,
} from './options'
