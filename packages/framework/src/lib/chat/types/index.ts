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
  getRenderedFromFrame,
  isContentPart,
  getMessageTextContent,
  getMessageReasoningContent,
  getMessageToolCalls,
} from './chat-message.ts'

// Sample types for LLM operations
export type {
  MessageRole,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ContentBlock,
  SampleMessage,
  ModelPreferences,
  ToolDefinition,
  ToolChoice,
  ToolCall,
  SamplePayload,
  SampleContent,
} from './sample.ts'

export {
  MessageRoleSchema,
  TextContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema,
  ContentBlockSchema,
  SampleMessageSchema,
  ModelPreferencesSchema,
  ToolDefinitionSchema,
  ToolChoiceSchema,
  ToolCallSchema,
  SamplePayloadSchema,
  SampleContentSchema,
  parseSamplePayload,
  parseSampleContent,
  safeParseSamplePayload,
  safeParseSampleContent,
} from './sample.ts'
