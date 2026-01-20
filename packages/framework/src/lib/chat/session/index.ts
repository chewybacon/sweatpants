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
} from './create-session.ts'

export type {
  ChatSession,
  ClientToolSessionOptions,
  HandoffResponseSignalValue,
} from './create-session.ts'

// Streaming
export { streamChatOnce, toApiMessages } from './stream-chat.ts'
export type { StreamChatOptions, ElicitResponseData } from './stream-chat.ts'

// Transforms
export {
  useTransformPipeline,
  passthroughTransform,
  loggingTransform,
} from './transforms.ts'

// Contexts
export {
  BaseUrlContext,
  StreamerContext,
  ToolRegistryContext,
} from './contexts.ts'

// Streaming types
export type {
  ApiMessage,
  ConversationState,
  StreamResult,
  StreamCompleteResult,
  StreamIsomorphicHandoffResult,
  StreamElicitResult,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  ElicitRequestStreamEvent,
  ToolSessionStatusStreamEvent,
  ToolSessionErrorStreamEvent,
  StreamEvent,
} from './streaming.ts'

// Options and configuration
export type {
  Streamer,
  MessageRenderer,
  PatchTransform,
  SessionOptions,
  ChatCommand,
} from './options.ts'
