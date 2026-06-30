import type { Operation, Stream, Channel } from "effection";
import type { Model, Runtime, StreamOptions } from "../../lib/chat/runtime/index.ts";
import type { ToolSessionSamplingProvider } from "../../lib/chat/mcp-tools/session/types.ts";
import type { ToolExecutionRef, ToolInventoryEntry, ToolRuntime } from "../../lib/chat/index.ts";
import type { StreamEvent, ChatMessage } from "../types.ts";
import type { PluginRegistry } from "../../lib/chat/mcp-tools/plugin-registry.ts";
import type {
  ComponentEmissionPayload,
  PendingEmission,
  ToolExecutionTrace,
} from "../../lib/chat/browser-rendering/index.ts";
import type { PluginSessionManager } from "./plugin-session-manager.ts";
import type { ConversationReplayState, AgUiRunMetadata } from "../../lib/chat/session/streaming.ts";
import type { ToolParameterValidationErrorPayload, ToolParameterValidationIssue } from "../../lib/chat/tool-parameters.ts";

export type EnginePhase =
  | "init"
  | "process_plugin_abort"
  | "process_plugin_responses"
  | "start_iteration"
  | "streaming_provider"
  | "provider_complete"
  | "executing_tools"
  | "tools_complete"
  | "awaiting_elicit"
  | "complete"
  | "error"
  | "done";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpToolRegistry {
  get(name: string): unknown | undefined;
  has(name: string): boolean;
  names(): string[];
}

export interface ElicitRequestData {
  sessionId: string;
  callId: string;
  toolName: string;
  elicitId: string;
  key: string;
  message: string;
  schema: Record<string, unknown>;
}

export type ToolExecutionResult =
  | {
      ok: true;
      kind: "result";
      callId: string;
      toolName: string;
      serverOutput: unknown;
      trace?: ToolExecutionTrace;
    }
  | {
      ok: true;
      kind: "plugin_awaiting";
      callId: string;
      toolName: string;
      sessionId: string;
      elicitRequest: ElicitRequestData;
    }
  | {
      ok: false;
      error: {
        callId: string;
        toolName: string;
        message: string;
        code?: string;
        issues?: ToolParameterValidationIssue[];
        validation?: ToolParameterValidationErrorPayload;
      };
    };

export interface ChatEngineParams {
  messages: ChatMessage[];
  replayState?: ConversationReplayState;
  systemPrompt?: string;
  toolSchemas: ToolSchema[];
  runtime: Runtime;
  model: Model;
  streamOptions?: StreamOptions;
  initialToolChoice?: StreamOptions["toolChoice"];
  toolInventoryEntries?: ToolInventoryEntry[];
  toolRuntime?: ToolRuntime;
  toolRuntimeId?: string;
  pluginSamplingProvider?: ToolSessionSamplingProvider;
  maxIterations: number;
  signal: AbortSignal;
  sessionInfo?: StreamEvent & { type: "session_info" };
  agUiRun: AgUiRunMetadata;
  pluginRegistry?: PluginRegistry;
  pluginEmissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void>;
  mcpToolRegistry?: McpToolRegistry;
  pluginSessionManager?: PluginSessionManager;
  elicitResponses?: ElicitResponse[];
  pluginAbort?: PluginAbortRequest;
}

export interface DurableStreamEvent {
  lsn: number;
  event: StreamEvent;
}

export interface ChatHandlerSetupContext {
  request: Request;
  body: ChatRequestBody;
}

export type ChatHandlerSetup = (ctx: ChatHandlerSetupContext) => Operation<void>;

export interface ElicitResponse {
  sessionId: string;
  callId: string;
  toolName?: string;
  ref?: ToolExecutionRef;
  elicitId: string;
  result: {
    action: "accept" | "decline" | "cancel";
    content?: unknown;
  };
  /** Browser render trace for replaying plugin UI after refresh. */
  trace?: ToolExecutionTrace;
}

export interface PluginAbortRequest {
  sessionId: string;
  reason?: string;
}

export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ChatRequestBody {
  messages: ChatMessage[];
  systemPrompt?: string;
  persona?: string;
  personaConfig?: unknown;
  enableOptionalTools?: string[];
  effort?: string;
  streamOptions?: StreamOptions;
  initialToolChoice?: StreamOptions["toolChoice"];
  enabledTools?: boolean | string[];
  enabledPlugins?: string[];
  model?: ModelSelection;
  elicitResponses?: ElicitResponse[];
  replayState?: ConversationReplayState;
  conversationId?: string;
  pluginAbort?: PluginAbortRequest;
}

export interface DurableChatHandlerConfig {
  setup?: ChatHandlerSetup;
  maxToolIterations?: number;
}

export interface DurableStreamParams {
  sessionId?: string;
  lastLSN?: number;
}

export type ChatEngine = Stream<StreamEvent, void>;
