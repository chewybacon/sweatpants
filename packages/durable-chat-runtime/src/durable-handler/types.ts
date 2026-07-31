import type { Operation } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import type { Model, Runtime, StreamOptions } from "@sweatpants/model-provider";
import type { ToolInventoryEntry } from "@sweatpants/tool-runtime";
import type { ToolRuntime } from "@sweatpants/tool-runtime";
import type { HistoryPolicy } from "@sweatpants/chat-core";
import type { StreamEvent, ChatMessage } from "../handler/types.ts";
import type { AgUiRunMetadata } from "@sweatpants/chat-core";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import type { HistoryStore } from "@sweatpants/history-store/contract";
import type { Json } from "@sweatpants/foundation";

import type {
  ChatHandlerSetup,
  ElicitResponse,
  PluginAbortRequest,
} from "../handler/chat-types.ts";

export type {
  ChatHandlerSetup,
  ChatHandlerSetupContext,
  ChatRequestBody,
  DurableStreamEvent,
  DurableStreamParams,
  ElicitResponse,
  ModelSelection,
  PluginAbortRequest,
} from "../handler/chat-types.ts";

export interface ToolSchema {
  name: string;
  description: string;
  /** Portable JSON Schema projection, computed once at authoring. */
  parameters: JsonObject;
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
  /** Commits accepted terminal authority output and publishes Session History. */
  publishTerminal(request: {
    outcome: Json;
    disposition: "completed" | "failed" | "cancelled";
    events: readonly StreamEvent[];
  }): Operation<void>;
}

export type ProgramRuntimeChatEngine = import("effection").Stream<StreamEvent, void>;

/**
 * Durable handler configuration. ProgramRuntime is the sole execution engine,
 * and its journal authority MUST be supplied by the host composition.
 */
export interface DurableChatHandlerConfig {
  setup?: ChatHandlerSetup;
  maxToolIterations?: number;
  programDriverJournalStore: ProgramDriverJournalStore;
  /** Bounded terminal/publication authority persistence; shared for Host replacement. */
  executionStore?: ExecutionStore;
  /** Session History persistence; shared for Host replacement. */
  historyStore?: HistoryStore<Json>;
}
