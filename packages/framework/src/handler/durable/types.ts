import type { Operation, Stream } from "effection";
import type { Model, Runtime, StreamOptions } from "@sweatpants/chat-core";
import type { ToolExecutionRef, ToolInventoryEntry, ToolRuntime } from "../../lib/chat/index.ts";
import type { HistoryPolicy } from "@sweatpants/chat-core";
import type { StreamEvent, ChatMessage } from "@sweatpants/durable-chat-runtime/handler/types";
import type { ToolExecutionTrace } from "../../lib/chat/browser-rendering/index.ts";
import type { ConversationReplayState, AgUiRunMetadata } from "@sweatpants/chat-core";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type { McpToolRegistry } from "@sweatpants/chat-core";

export interface ProgramRuntimeChatEngineParams {
  messages: ChatMessage[];
  systemPrompt?: string;
  toolSchemas: ToolSchema[];
  runtime: Runtime;
  model: Model;
  streamOptions?: StreamOptions;
  initialToolChoice?: StreamOptions["toolChoice"];
  toolInventoryEntries?: ToolInventoryEntry[];
  toolRuntime?: ToolRuntime;
  /**
   * F5: explicit opt-in retention policy for outer-chat model requests.
   * Resolved from HistoryPolicyContext at request time because the engine
   * runs inside a background writer task that does not inherit the
   * request-scoped contexts.
   */
  historyPolicy?: HistoryPolicy;
  maxIterations: number;
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
  elicitResponses?: ElicitResponse[];
  /** Called only after all resume commands are durably accepted. */
  onResumeAccepted?: () => Operation<void>;
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
  /** Optional legacy runtime correlation; Program Runtime cancellation uses the active durable root. */
  sessionId?: string;
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

/**
 * Durable handler configuration. ProgramRuntime is the sole execution engine,
 * and its journal authority MUST be supplied by the host composition.
 */
export interface DurableChatHandlerConfig {
  setup?: ChatHandlerSetup;
  maxToolIterations?: number;
  programDriverJournalStore: ProgramDriverJournalStore;
}

export interface DurableStreamParams {
  sessionId?: string;
  lastLSN?: number;
}

export type ProgramRuntimeChatEngine = Stream<StreamEvent, void>;
