import type { Operation, Stream } from "effection";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { Model, StreamOptions } from "@sweatpants/model-provider";
import type { ToolInventoryEntry, ToolRuntime } from "@sweatpants/tool-runtime";
import type { AgUiRunMetadata, ConversationAuthority, HistoryPolicy } from "@sweatpants/chat-core";
import type { StreamEvent, ChatHistoryEntry } from "../handler/types.ts";
import type { ModelContextSource } from "@sweatpants/model-sampling";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import type { ProjectionTokenKeyring } from "../projection-tokens.ts";

import type {
  ChatHandlerSetup,
  ElicitResponse,
  PluginAbortRequest,
} from "../handler/chat-types.ts";

export type {
  ChatHandlerSetup,
  ChatHandlerSetupContext,
  ChatRequestBody,
  ElicitResponse,
  PluginAbortRequest,
} from "../handler/chat-types.ts";

export interface ToolSchema {
  name: string;
  description: string;
  /** Portable JSON Schema projection, computed once at authoring. */
  parameters: JsonObject;
}

export type { McpToolRegistry } from "@sweatpants/chat-core";

export interface WorkflowChatEngineParams {
  messages: readonly ChatHistoryEntry[];
  /** Durable source recipe used by the chat-root task instead of full history input. */
  modelContextSource?: ModelContextSource;
  systemPrompt?: string;
  toolSchemas: ToolSchema[];
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
   * - server-internal response-tail identity never appears here
   */
  conversationId: string;
  conversationStore: ConversationStore;
  /** Trusted participant bound to newly opened elicitation audiences. */
  participantId: string;
  agUiRun: AgUiRunMetadata;
  /** Reattach existing canonical input without interpreting an empty GET body as replacement. */
  recoveryOnly?: boolean;
  /** Signals when the journal-native root can accept process-local cancellation. */
  onLiveTaskReady?: (taskId: string) => void;
  /** Releases process-local Host ownership after the engine resource settles. */
  onLiveActivationSettled?: (error?: Error) => void;
  elicitResponses?: ElicitResponse[];
  /** Called only after all resume commands are durably accepted. */
  onResumeAccepted?: () => Operation<void>;
  pluginAbort?: PluginAbortRequest;
  /** Publishes a bounded nonterminal checkpoint for a parked execution. */
  publishCheckpoint?: (request: { events: readonly StreamEvent[] }) => Operation<{
    readonly authority: ConversationAuthority;
    readonly window?: import("@sweatpants/chat-core").ConversationWindowFrame;
  }>;
  /** Commits accepted terminal authority output and publishes Session History. */
  publishTerminal(request: {
    outcome: Json;
    disposition: "completed" | "failed" | "cancelled";
    events: readonly StreamEvent[];
  }): Operation<{
    readonly authority: ConversationAuthority;
    readonly window?: import("@sweatpants/chat-core").ConversationWindowFrame;
  }>;
}

export type WorkflowChatEngine = Stream<StreamEvent, void>;

/**
 * Durable handler configuration. workflow host is the sole execution engine,
 * and its journal authority MUST be supplied by the host composition.
 */
export type HistoryReadAuthorization = "authorized" | "unauthenticated" | "forbidden";

export interface DurableChatHandlerConfig {
  setup?: ChatHandlerSetup;
  maxToolIterations?: number;
  /** Trusted composition identity; wire clientId remains correlation only. */
  resolveParticipantId?: (request: Request) => Operation<string>;
  programDriverJournalStore: ProgramDriverJournalStore;
  /** Bounded private execution authority persistence; shared for Host replacement. */
  executionStore?: ExecutionStore;
  /** Authoritative conversation persistence; shared for Host replacement. */
  conversationStore?: ConversationStore;
  /** Integrity keys for opaque window/history projection tokens. */
  projectionTokens: ProjectionTokenKeyring;
  /** Projection token validity; defaults to fifteen minutes. */
  projectionTokenTtlMs?: number;
  /** Authenticates and authorizes history reads before token verification or store access. */
  authorizeHistoryRead: (
    request: Request,
    conversationId: string,
  ) => Operation<HistoryReadAuthorization>;
  /** Lowers spill/segment targets for the durability walking skeleton. */
  storageProfile?: "low" | "default";
}
