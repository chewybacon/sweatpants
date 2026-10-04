/**
 * MCP Tools Module
 *
 * MCP adapter/runtime utilities for canonical core tools.
 *
 * Tool authoring is owned by `@sweatpants/agent-sdk`:
 *
 * ```typescript
 * import { createTool } from '@sweatpants/agent-sdk/tools'
 *
 * const analyze = createTool('analyze')
 *   .description('Analyze input')
 *   .parameters(z.object({ input: z.string() }))
 *   .samples()
 *   .execute(function*(params, ctx) {
 *     const first = yield* ctx.sample({ prompt: `Analyze ${params.input}` })
 *     return { text: first.text }
 *   })
 * ```
 *
 * This module exposes MCP projection, protocol, plugin, and execution helpers.
 * It no longer publicly exports MCP-specific tool builders.
 *
 * @packageDocumentation
 */

export * from "./durable-invocation.ts";
export * from "./durable-transport.ts";

// Types from unified types file
export type {
  // Execution limits
  McpToolLimits,
  // MCP elicitation types
  ClientElicitConfig,
  ElicitId,
  ElicitRequest,
} from "./mcp-tool-types.ts";

// Errors from unified types file
export {
  McpCapabilityError,
  ElicitationDeclinedError,
  ElicitationCancelledError,
  McpToolTokenError,
  McpDisconnectError,
} from "./mcp-tool-types.ts";

// Mock runtime helpers for adapter tests.
export { createMockMCPClient, runMCPTool } from "./mock-runtime.ts";
export type { MockMCPClient, MockMCPClientConfig, RunMCPToolOptions } from "./mock-runtime.ts";
export {
  projectCoreElicitExchangeToMcpMessages,
  projectCoreSampleExchangeToMcpMessages,
  projectCoreInteractionExchangeToMcpMessages,
  projectCoreExchangesToMcpMessages,
} from "./core-exchange-projection.ts";

// =============================================================================
// PLUGIN SYSTEM (bridgeable tools -> framework-native plugins)
// =============================================================================

export {
  createPluginBuilder,
  createPluginRegistry,
  createPluginRegistryFrom,
  makePlugin,
} from "./plugin.ts";
export {
  executeClientElicitHandler,
  createClientElicitDispatcher,
  ClientElicitDiagnostic,
} from "./client-dispatcher.ts";
export type {
  ClientDispatcherOptions,
  ClientDiagnosticCode,
  ClientElicitDispatcher,
} from "./client-dispatcher.ts";
export type {
  ClientElicitBinding,
  ClientElicitRequest as RawClientElicit,
  ClientPlugin,
  ClientPluginRegistration,
  ElicitHandler,
  ElicitHandlerInput,
  ElicitHandlerMetadata,
  ElicitHandlers,
  PluginBuilder,
  PluginBuilderWithHandlers,
  PluginRegistry,
  PluginToolContract,
} from "./plugin.ts";

// =============================================================================
// BRIDGE RUNTIME (in-app tool execution with UI elicitation)
// =============================================================================

export { createBridgeHost, runBridgeTool } from "./bridge-runtime.ts";
export type {
  BridgeHost,
  BridgeHostConfig,
  BridgeEvent,
  BridgeSamplingProvider,
  BridgeSampleOptions,
  BridgeElicitHandlers,
  ElicitResponse,
  SampleResponse,
} from "./bridge-runtime.ts";

// =============================================================================
// MCP PROTOCOL (JSON-RPC encoding/decoding, SSE formatting)
// =============================================================================

export { MCP_PROTOCOL_VERSION } from "./protocol-version.ts";

export {
  // Encoder
  encodeProgressNotification,
  encodeLogNotification,
  encodeElicitationRequest,
  encodeSamplingRequest,
  encodeToolCallResult,
  encodeToolCallError,
  encodeToolCallCancelled,

  // Decoder
  decodeElicitationResponse,
  decodeSamplingResponse,
  decodeToolCallRequest,
  decodeResponse,
  createDecoderContext,
  MCP_MAX_MESSAGE_BYTES,
  parseJsonRpcMessage,

  // SSE
  formatSseEvent,
  formatMessageAsSse,
  parseSseEvent,
  parseSseChunk,
  createSseHeaders,

  // Type guards
  isJsonRpcError,
  isJsonRpcSuccess,
  isTextContent,
  isToolUseContent,
  isToolResultContent,

  // Error codes
  JSON_RPC_ERROR_CODES,
  MCP_ERROR_CODES,
} from "./protocol/index.ts";

export type {
  // JSON-RPC types
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcResponse,

  // MCP content types
  McpTextContent,
  McpImageContent,
  McpAudioContent,
  McpResourceContent,
  McpToolUseContent,
  McpToolResultContent,
  McpContentBlock,

  // MCP message types
  McpRole,
  McpMessage,

  // Sampling types
  McpModelPreferences,
  McpToolChoice,
  McpToolDefinition,
  McpStopReason,
  McpCreateMessageParams,
  McpCreateMessageResult,

  // Elicitation types
  McpElicitationMode,
  McpElicitationAction,
  McpElicitationParams,
  McpElicitationResult,

  // Notification types
  McpProgressParams,
  McpLogLevel,
  McpMessageParams,

  // Tool types
  McpToolCallParams,
  McpToolCallResult,

  // SSE types
  SseEvent,

  // Encoder/decoder types
  DecodedMessage,
  DecoderContext,
  PendingRequest,
  ParsedJsonRpcMessage,
} from "./protocol/index.ts";

// =============================================================================
// MCP HTTP HANDLER (Streamable HTTP transport)
// =============================================================================

export { createMcpHandler } from "./handler/mcp-handler.ts";
export type { McpHandlerOptions, McpHttpHandler } from "./handler/mcp-handler.ts";
export { generateMcpManifest } from "./handler/manifest.ts";
export type { McpManifest, GenerateMcpManifestOptions } from "./handler/manifest.ts";

export {
  createMcpContinuations,
  decodeMcpFormResponse,
  McpContinuationError,
} from "./continuations.ts";
export type {
  McpContinuations,
  McpContinuationBinding,
  McpContinuationReference,
  McpFormResponse,
} from "./continuations.ts";

export {
  readMcpRequestMetadata,
  encodeMcpHeaderValue,
  requireMcpFormCapability,
  McpRequestMetadataError,
} from "./request-metadata.ts";

export type { McpFormAdapter, McpFormAdapters } from "./handler/interactions.ts";
