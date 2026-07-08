import type { Operation, Stream, Channel } from "effection";
import type { Model, Runtime, StreamOptions } from "../../lib/chat/runtime/index.ts";
import type { ToolSessionSamplingProvider } from "../../lib/chat/mcp-tools/session/types.ts";
import type { ToolExecutionRef, ToolInventoryEntry, ToolRuntime } from "../../lib/chat/index.ts";
import type { StreamEvent, ChatMessage } from "../types.ts";
import type { TokenBufferStore, LogRecord } from "@sweatpants/session-contract";
import type { PluginRegistry } from "../../lib/chat/mcp-tools/plugin-registry.ts";
import type {
  ComponentEmissionPayload,
  PendingEmission,
  ToolExecutionTrace,
} from "../../lib/chat/browser-rendering/index.ts";
import type { PluginSessionManager } from "./plugin-session-manager.ts";
import type { ConversationReplayState, AgUiRunMetadata } from "../../lib/chat/session/streaming.ts";

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

export interface SessionContractChatEngineParams {
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
  /**
   * Optional shared fold-session buffer store. When provided, the adapter
   * reopens the existing fold session on resume instead of creating an
   * ephemeral one, enabling the fold driver's restore/continuation path.
   */
  foldSessionBufferStore?: TokenBufferStore<LogRecord>;
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

export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export interface ChatRequestBody {
  /** AG-UI thread id for strict public requests. Falls back to conversation/session id. */
  threadId?: string;
  /** AG-UI run id for strict public requests. Falls back to the durable session id. */
  runId?: string;
  /** Parent AG-UI run id for resumed runs. */
  parentRunId?: string;
  state?: unknown;
  tools?: unknown[];
  context?: Array<{ description: string; value: string }>;
  forwardedProps?: unknown;
  resume?: ResumeEntry[];
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

export type SessionContractChatEngine = Stream<StreamEvent, void>;
