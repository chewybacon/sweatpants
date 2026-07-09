/**
 * lib/chat/session/stream-chat.ts
 *
 * Effection operation for a single streaming chat request.
 * Bridges async generator → Effection stream, with proper cancellation.
 *
 * Responsibilities:
 * - Create abortable fetch using Effection's useAbortSignal
 * - Parse response body via parseNDJSON Effection stream
 * - Convert to Effection stream and consume with each()
 * - Emit patches for each event
 * - Emit elicit patches when runtime tools request browser/user input
 */
import type { Operation, Channel } from 'effection'
import { useAbortSignal } from 'effection'
import { parseNDJSON } from '../ndjson.ts'
import { BaseUrlContext } from './contexts.ts'
import type { ChatPatch } from '../patches/index.ts'
import type { Message } from '../types.ts'
import type { StreamChatOptions } from './options.ts'
import type { StreamResult } from './streaming.ts'
import { executeChatFetch } from './api-transport.ts'
import { mapStreamEventsToPatches } from './event-mapper.ts'

/**
 * Re-export ElicitResponseData from options for backward compatibility.
 */
export type { ElicitResponseData, StreamChatOptions } from './options.ts'

/**
 * Perform a single streaming chat request.
 * Emits patches to the provided channel as events arrive.
 *
 * @param messages - The conversation history to send
 * @param patches - Channel to emit patches to
 * @param options - Optional configuration for the chat
 * @returns StreamResult - complete or waiting for elicitation
 */
export function* streamChatOnce(
  messages: Message[],
  patches: Channel<ChatPatch, void>,
  options: StreamChatOptions = {}
): Operation<StreamResult> {
  // Get abort signal scoped to this operation
  const signal = yield* useAbortSignal()

  // Determine API URL: options override > context > default
  // BaseUrlContext has a default of '/api/chat', so .get() always returns a value
  const contextBaseUrl = yield* BaseUrlContext.get()
  const baseUrl = options.baseUrl ?? contextBaseUrl ?? '/api/chat'

  const response = yield* executeChatFetch(baseUrl, messages, options, signal)
  const conversationId = response.headers.get('X-Conversation-Id')?.trim() || undefined

  // Create Effection stream for NDJSON parsing
  // Server returns { lsn, event } wrapper format (durable streaming)
  // We parse as unknown and extract the inner event
  const eventStream = parseNDJSON<unknown>(response.body!, { signal })

  const result = yield* mapStreamEventsToPatches(eventStream, patches, options.onStreamEvent)
  return conversationId ? { ...result, conversationId } : result
}
