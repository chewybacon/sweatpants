// Types
export * from './types.ts'

// Stream utilities
export * from './ndjson.ts'
export * from './stream.ts'
export * from './sse.ts'

// Providers - exported from main chat.ts to avoid conflicts
export { getChatProvider, ollamaProvider, openaiProvider } from './providers/index.ts'
export * from './providers/contexts.ts'

export * from './personas/index.ts'

// Model context utilities (browser-safe subset of mcp-tools)
export { stripMessageContext, getElicitContext } from './mcp-tools/model-context.ts'

// MCP tool builder (browser-safe - only types, no Node.js deps)
export { createMcpTool } from './mcp-tools/mcp-tool-builder.ts'

// Sample result types for structured output and tool calling
export type {
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolCall,
  SamplingToolDefinition,
  SamplingToolChoice,
  // Extended message type for conversation history
  ExtendedMessage,
  // MCP message types for tool interactions
  McpMessage,
  McpContentBlock,
  McpTextContent,
  McpToolUseContent,
  McpToolResultContent,
  // Exchange types for history accumulation
  ElicitExchange,
  SampleExchange,
} from './mcp-tools/mcp-tool-types.ts'

// Plugin builder (browser-safe)
export { makePlugin } from './mcp-tools/plugin.ts'
export type {
  McpPlugin,
  PluginBuilder,
  PluginBuilderWithHandlers,
  PluginServerRegistration,
  PluginClientRegistration,
  PluginClientRegistrationInput,
  PluginClientContext,
  ElicitHandler,
  ElicitHandlers,
  InferElicits,
  InferPluginTool,
  AnyMcpPlugin,
  RenderableProps,
  UserProps,
  ExtractResponse,
} from './mcp-tools/plugin.ts'

// Logger
export {
  type Logger,
  type LoggerFactory,
  useLogger,
  setupLogger,
  createPinoLoggerFactory,
  createNoopLogger,
  LoggerFactoryContext,
  type PinoLoggerOptions,
} from '../logger/index.ts'

