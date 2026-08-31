import type { Operation, Scope, Stream } from "effection";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { SchemaBinding } from "@sweatpants/foundation/schema";
import type { Model, StreamOptions } from "@sweatpants/model-provider";
import type { ToolInventoryEntry, ToolRuntime } from "@sweatpants/tool-runtime";
import type { AgUiRunMetadata, ConversationAuthority, HistoryPolicy } from "@sweatpants/chat-core";
import type {
  ConversationStreamEvent as StreamEvent,
  ChatHistoryEntry,
} from "@sweatpants/chat-core";
import type { ModelContextSource } from "@sweatpants/model-sampling";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import type { ProjectionTokenKeyring } from "../projection-tokens.ts";
import type { ScopedEndpoint } from "../streaming.ts";
import type { ChatStorageConfig } from "./storage.ts";

import type { ChatHandlerSetup, ElicitResponse, PluginAbortRequest } from "./chat-types.ts";

export type {
  ChatHandlerSetup,
  ChatHandlerSetupContext,
  ChatRequestBody,
  ElicitResponse,
  PluginAbortRequest,
} from "./chat-types.ts";

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

export interface DurableChatReadRequest {
  readonly request: Request;
  readonly conversationId: string;
  readonly knownWindowToken?: string;
}

export interface DurableHistoryPageRequest {
  readonly request: Request;
  readonly conversationId: string;
}

/** Read-only view of the authority composition bound to one application scope. */
export interface DurableChatStorageInspection {
  readonly conversationStore: ConversationStore;
  readonly executionStore: ExecutionStore;
  readonly programDriverJournalStore: ProgramDriverJournalStore;
}

export interface DurableChatEndpoints {
  readonly postChat: ScopedEndpoint<Request>;
  readonly readChat: ScopedEndpoint<DurableChatReadRequest>;
  readonly pageHistory: ScopedEndpoint<DurableHistoryPageRequest>;
  /**
   * Resolves the storage composition owned by `scope`, opening it if the
   * first request has not arrived yet. Intended for development inspectors
   * and diagnostics, not request handling.
   */
  readonly inspect: (scope: Scope) => Promise<DurableChatStorageInspection>;
}

/**
 * Minimal shape of a durable tool or program definition that contributes
 * journal schema bindings, such as tools built with the durable tool SDK.
 */
export interface DurableChatProgram {
  readonly artifacts: { readonly catalog: Iterable<SchemaBinding> };
}

/** Options shared by both configuration modes. */
export interface DurableChatHandlerOptions {
  /** Request-scoped setup: install model providers and per-request contexts. */
  setup?: ChatHandlerSetup;
  maxToolIterations?: number;
  /** Trusted composition identity; wire clientId remains correlation only. */
  resolveParticipantId?: (request: Request) => Operation<string>;
  /** One explicit authority-storage choice. There is no implicit fallback. */
  storage: ChatStorageConfig;
  /** Projection token validity; defaults to fifteen minutes. */
  projectionTokenTtlMs?: number;
  /**
   * Authenticates and authorizes history reads before token verification or
   * store access. Defaults to `authorized`: deployments that expose history
   * routes beyond a trusted boundary MUST override this.
   */
  authorizeHistoryRead?: (
    request: Request,
    conversationId: string,
  ) => Operation<HistoryReadAuthorization>;
}

/**
 * Simple mode: one stable application `name` plus one deployment `secret`
 * (32+ UTF-8 bytes) derive the journal capability keyring, journal prefix,
 * and projection-token keys. `programs` contributes durable tool schemas.
 * Each derived piece may still be overridden individually.
 */
export interface DurableChatIdentityConfig extends DurableChatHandlerOptions {
  /** Stable application identity; seeds journal audience, key id, and prefix. */
  name: string;
  /** Deployment secret (32–4096 UTF-8 bytes) for capability and token keys. */
  secret: string;
  /** Durable tools/programs whose schema catalogs the journal must accept. */
  programs?: readonly DurableChatProgram[];
  /** Override: builds the journal over the ExecutionStore selected by `storage`. */
  createProgramDriverJournalStore?: (executionStore: ExecutionStore) => ProgramDriverJournalStore;
  /** Override: integrity keys for opaque window/history projection tokens. */
  projectionTokens?: ProjectionTokenKeyring;
}

/** Advanced mode: the composition supplies every authority piece explicitly. */
export interface DurableChatCompositionConfig extends DurableChatHandlerOptions {
  name?: string;
  secret?: undefined;
  programs?: undefined;
  /** Builds the journal over the exact ExecutionStore selected by `storage`. */
  createProgramDriverJournalStore: (executionStore: ExecutionStore) => ProgramDriverJournalStore;
  /** Integrity keys for opaque window/history projection tokens. */
  projectionTokens: ProjectionTokenKeyring;
}

export type DurableChatHandlerConfig = DurableChatIdentityConfig | DurableChatCompositionConfig;
