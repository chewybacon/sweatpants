import type { Operation, Stream, Channel } from "effection";
import type { Model, Runtime, StreamOptions } from "../../lib/chat/runtime/index.ts";
import type { ToolSessionSamplingProvider } from "../../lib/chat/mcp-tools/session/types.ts";
import type { ToolExecutionRef, ToolInventoryEntry, ToolRuntime } from "../../lib/chat/index.ts";
import type { StreamEvent, ChatMessage } from "../types.ts";
import type { CrankStore } from "@sweatpants/session-contract";
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
  /**
   * Durable conversation identity. This is the only key used for the fold
   * session log.
   *
   * Identity law:
   * - conversationId keys the crank journal
   * - agUiRun.threadId is always the wire alias of conversationId
   * - agUiRun.runId is ephemeral turn correlation only
   * - HTTP X-Session-Id (response stream) never appears here
   */
  conversationId: string;
  agUiRun: AgUiRunMetadata;
  pluginRegistry?: PluginRegistry;
  pluginEmissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void>;
  mcpToolRegistry?: McpToolRegistry;
  pluginSessionManager?: PluginSessionManager;
  /** Shared fenced crank store. Product hosts install it once per process. */
  crankStore?: CrankStore;
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
  /**
   * Durable conversation identity. Preferred over threadId.
   * This is the only durable chat key (crank journal, history, resume).
   */
  conversationId?: string;
  /**
   * AG-UI wire alias for conversationId. If conversationId is absent, threadId
   * is accepted as the durable conversation key. Divergent threadId values are
   * normalized to conversationId on the wire.
   */
  threadId?: string;
  /**
   * Ephemeral AG-UI run correlation for one request/turn. Never a durable chat
   * key. If omitted, the server mints a fresh runId (never reuses stream id).
   */
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
