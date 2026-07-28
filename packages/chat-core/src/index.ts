/**
 * @packageDocumentation
 *
 * @sweatpants/chat-core — chat messages, Turn state, model contracts,
 * personas, and portable codecs.
 *
 * This package owns the protocol-neutral chat domain types that are shared
 * across the durable runtime, UI adapters, and tool runtimes. It does NOT
 * own HTTP hosting, CAS persistence, or MCP server mechanics.
 */

// Core message types
export type {
  Message,
  ToolCall,
  ChatEvent,
  ChatResult,
  ClientToolSchema,
  OllamaChatRequest,
  OllamaChatChunk,
} from "./messages.ts";

// Shared primitives
export type {
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
  ToolCallInfo,
  ServerToolResult,
} from "./core-types.ts";

// Frame protocol
export * from "./frame.ts";

// Persona resolver
export type { PersonaResolver, ResolvedPersona } from "./setup-types.ts";

// Portable stream codecs
export * from "./ndjson.ts";
export * from "./stream.ts";
export * from "./sse.ts";

// Model-provider port and context
export * from "./model-provider.ts";

// History policy
export * from "./history-policy.ts";

// Runtime types (Model, Runtime, Context, StreamEvent, StreamOptions, etc.)
export * from "./runtime/index.ts";

// Message part types
export * from "./types/index.ts";

// Personas
export * from "./personas/index.ts";

// Registry interface
export type { McpToolRegistry } from "./registry-types.ts";

// Trace types (tool execution emissions)
export type {
  ComponentTypeLike,
  ComponentEmissionPayload,
  EmissionTraceEntry,
  HydratedEmissionTraceEntry,
  HydratedToolExecutionTrace,
  ToolExecutionTrace,
} from "./trace-types.ts";

// Emission runtime primitives
export {
  createRuntime,
  createComponentHandler,
  getComponentKey,
  COMPONENT_EMISSION_TYPE,
  type Emission,
  type PendingEmission,
  type EmissionHandler,
  type RuntimeConfig,
  type RuntimePrimitive,
} from "./emissions.ts";
