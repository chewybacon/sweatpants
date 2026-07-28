// Narrow shim for AgentCore-bundled app tools that need the canonical core
// tool authoring surface without importing the full chat barrel.
//
// The full chat barrel also exports providers/logger/client utilities. Bundling
// that whole barrel into the ESM AgentCore runtime pulls in pino's CommonJS
// dynamic requires. App tools only need the core builder at runtime, so this
// shim keeps the AgentCore bundle minimal and ESM-safe.
export { createTool } from "@sweatpants/core";
export {
  installModelProvider,
  ModelProviderModelContext,
  ModelProviderStreamOptionsContext,
} from "@sweatpants/chat-core/model-provider";
export {
  installToolRuntime,
  ToolRuntimeError,
  createToolExecutionRef,
} from "../../../packages/framework/src/lib/chat/tool-runtime.ts";
export type { ExtendedMessage } from "../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts";
export type { ModelProviderDriver } from "@sweatpants/chat-core/model-provider";
export type {
  ElicitToolRequest,
  ToolExecuteRequest,
  ToolExecution,
  ToolExecutionEvent,
  ToolExecutionRef,
  ToolResumeRequest,
  ToolRuntime,
} from "../../../packages/framework/src/lib/chat/tool-runtime.ts";
export type { ToolCall } from "../../../packages/framework/src/lib/chat/types.ts";
export type {
  ToolDefinition,
  ToolInventoryEntry,
} from "../../../packages/framework/src/lib/chat/tool-inventory.ts";
