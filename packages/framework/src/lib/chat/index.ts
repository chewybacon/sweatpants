// Types
export * from './types'

// Stream utilities
export * from './ndjson'
export * from './stream'
export * from './sse'

// Providers - exported from main chat.ts to avoid conflicts
export { getChatProvider, ollamaProvider, openaiProvider } from './providers'
export * from './providers/contexts'

export * from './personas'

// Model context utilities (browser-safe subset of mcp-tools)
export { stripMessageContext, getElicitContext } from './mcp-tools/model-context'

// MCP tool builder (browser-safe - only types, no Node.js deps)
export { createMcpTool } from './mcp-tools/mcp-tool-builder'

// Sample result types for structured output and tool calling
export type {
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolCall,
  SamplingToolDefinition,
  SamplingToolChoice,
} from './mcp-tools/mcp-tool-types'

// Plugin builder (browser-safe)
export { makePlugin } from './mcp-tools/plugin'
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
  InferPluginElicits,
  InferPluginTool,
  AnyMcpPlugin,
  RenderableProps,
  UserProps,
  ExtractResponse,
} from './mcp-tools/plugin'

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
} from '../logger'

