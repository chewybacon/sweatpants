/**
 * react/chat/session.ts
 *
 * Backwards-compatible re-export from lib/chat/session.
 *
 * @deprecated Import from '@tanstack/framework/lib/chat/session' instead
 */

// Re-export everything from the framework-agnostic session module
export {
  createChatSession,
  runChatSession,
  createChatSessionChannels,
} from '../../lib/chat/session'

export type {
  ChatSession,
  ClientToolSessionOptions,
  HandoffResponseSignalValue,
} from '../../lib/chat/session'
