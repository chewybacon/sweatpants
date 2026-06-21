/**
 * lib/chat/types/index.ts
 *
 * Framework-agnostic chat types.
 */

export type {
  ChatEmission,
  ChatToolCall,
  ChatMessage,
  StreamingMessage,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  MessagePart,
  ContentPart,
} from './chat-message.ts'

export {
  generatePartId,
  resetPartIdCounter,
  createTextPart,
  createReasoningPart,
  createToolCallPart,
  createToolResultPart,
  getRenderedFromFrame,
  isContentPart,
  getMessageTextContent,
  getMessageReasoningContent,
  getMessageToolCalls,
} from './chat-message.ts'
