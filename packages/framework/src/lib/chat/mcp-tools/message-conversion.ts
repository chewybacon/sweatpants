/**
 * Message Conversion Utilities
 *
 * Converts between ExtendedMessage variants (MCP pipeline) and
 * the chat provider Message format (OpenAI-compatible).
 *
 * ## Conversion Direction
 *
 * ExtendedMessage → Chat Provider Message
 *
 * This handles the "outbound" conversion at the provider boundary,
 * where MCP-format messages need to become OpenAI-compatible messages
 * for chat providers.
 *
 * ## Variants Handled
 *
 * - Message (string content) → passthrough
 * - McpMessage with tool_use blocks → assistant message with tool_calls
 * - McpMessage with tool_result blocks → tool message with tool_call_id
 * - McpMessage text-only → plain message with joined text
 * - ToolCallMessage → passthrough (already provider format)
 * - ToolResultMessage → passthrough (already provider format)
 *
 * @packageDocumentation
 */

import type { Message as ChatMessage } from '../types.ts'
import type {
  ExtendedMessage,
  ToolCallMessage,
  ToolResultMessage,
} from './mcp-tool-types.ts'
import type { McpMessage, McpContentBlock } from './protocol/types.ts'
import {
  messageIdForAssistantFinal,
  messageIdForAssistantTools,
  messageIdForTool,
  messageIdForUser,
} from '../session/message-identity.ts'

/**
 * Type guard for ToolCallMessage (assistant message with tool_calls).
 */
export function isToolCallMessage(msg: ExtendedMessage): msg is ToolCallMessage {
  return 'tool_calls' in msg && Array.isArray((msg as ToolCallMessage).tool_calls)
}

/**
 * Type guard for ToolResultMessage (tool result with tool_call_id).
 */
export function isToolResultMessage(msg: ExtendedMessage): msg is ToolResultMessage {
  return 'tool_call_id' in msg && (msg as ToolResultMessage).role === 'tool'
}

/**
 * Type guard for McpMessage (content is an array of content blocks or a single block).
 */
function isMcpMessage(msg: ExtendedMessage): msg is McpMessage {
  return typeof msg.content !== 'string' && !isToolCallMessage(msg) && !isToolResultMessage(msg)
}

/**
 * Convert an ExtendedMessage to the chat provider's Message format.
 *
 * Handles all ExtendedMessage variants:
 * - Message (string content) → passthrough with role cast
 * - McpMessage with tool_use blocks → `{ role: 'assistant', content, tool_calls }`
 * - McpMessage with tool_result blocks → `{ role: 'tool', content, tool_call_id }`
 * - McpMessage text-only → `{ role, content: joined text }`
 * - ToolCallMessage → passthrough (already provider format)
 * - ToolResultMessage → passthrough (already provider format)
 */
export function extendedMessageToProviderMessage(msg: ExtendedMessage): ChatMessage {
  // ToolCallMessage — already in provider format
  if (isToolCallMessage(msg)) {
    return {
      id: messageIdForAssistantTools(msg.tool_calls.map((toolCall) => toolCall.id)),
      role: msg.role,
      content: msg.content,
      tool_calls: msg.tool_calls,
    }
  }

  // ToolResultMessage — already in provider format
  if (isToolResultMessage(msg)) {
    return {
      id: messageIdForTool(msg.tool_call_id),
      role: msg.role,
      content: msg.content,
      tool_call_id: msg.tool_call_id,
    }
  }

  // Plain Message with string content — passthrough
  if (!isMcpMessage(msg)) {
    return {
      id: msg.role === 'assistant' ? messageIdForAssistantFinal('mcp') : messageIdForUser('mcp'),
      role: msg.role as ChatMessage['role'],
      content: msg.content as string,
    }
  }

  // McpMessage with content blocks — convert based on block types
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]

  // Extract text from text blocks
  const textContent = blocks
    .filter((b): b is Extract<McpContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')

  // Check for tool_use blocks → assistant message with tool_calls
  const toolUseBlocks = blocks.filter(
    (b): b is Extract<McpContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  )
  if (toolUseBlocks.length > 0) {
    return {
      id: messageIdForAssistantTools(toolUseBlocks.map((b) => b.id)),
      role: 'assistant',
      content: textContent,
      tool_calls: toolUseBlocks.map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: b.input },
      })),
    }
  }

  // Check for tool_result blocks → tool message with tool_call_id
  const toolResultBlocks = blocks.filter(
    (b): b is Extract<McpContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  )
  if (toolResultBlocks.length > 0 && toolResultBlocks[0]) {
    const firstResult = toolResultBlocks[0]
    const resultText = firstResult.content
      .filter((b): b is Extract<McpContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return {
      id: messageIdForTool(firstResult.toolUseId),
      role: 'tool',
      content: resultText,
      tool_call_id: firstResult.toolUseId,
    }
  }

  // Text-only MCP message
  return {
    id: msg.role === 'assistant' ? messageIdForAssistantFinal('mcp') : messageIdForUser('mcp'),
    role: msg.role as ChatMessage['role'],
    content: textContent,
  }
}
