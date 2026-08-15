import type { Operation, Stream } from "effection";
import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  CustomEvent,
  Message,
  MessagesSnapshotEvent,
  RawEvent,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { ConversationAuthority, ConversationStreamEvent } from "./conversation-protocol.ts";
import type { PublicActivityPlacement } from "./public-activity.ts";
export type {
  JsonPatchOperation,
  StructuredOutputCompleteEvent,
  StructuredOutputStartEvent,
} from "./chat-protocol-types.ts";
export type {
  PublicActivityData,
  PublicActivityNode,
  PublicActivityPlacement,
  PublicElicitActivityNode,
  PublicGenericActivityNode,
  PublicMessageActivityNode,
  PublicToolActivityNode,
  PublicToolActivityData,
  SweatpantsPublicActivity,
} from "./public-activity.ts";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { ChatContent, ChatContentSource } from "./content.ts";
import type { Frame } from "./frame.ts";

/** A generic local part supplied by a frontend adapter. */
export interface ChatLocalPart {
  readonly type: string;
  readonly id: string;
}

export interface ChatUIMessage<TLocalPart extends ChatLocalPart = never> {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly parts: readonly ChatUIPart<TLocalPart>[];
  readonly metadata: JsonObject;
}

export type ChatUIPart<TLocalPart extends ChatLocalPart = never> =
  | ChatUITextPart
  | ChatUIReasoningPart
  | ChatUIStructuredOutputPart
  | ChatUIMediaPart
  | ChatUIToolCallPart<TLocalPart>
  | ChatUINestedMessagePart<TLocalPart>
  | ChatUIActivityPart<TLocalPart>
  | ChatUIElicitPart<TLocalPart>
  | TLocalPart;

export interface ChatUITextPart {
  readonly type: "text";
  readonly id: string;
  readonly text: string;
  readonly state: "streaming" | "done";
  readonly frame: Frame;
  readonly rendered: string;
}

export interface ChatUIReasoningPart {
  readonly type: "reasoning";
  readonly id: string;
  readonly text: string;
  readonly state: "streaming" | "done";
  readonly frame: Frame;
  readonly rendered: string;
}

interface ChatUIStructuredOutputBase {
  readonly type: "structured-output";
  readonly id: string;
  readonly raw: string;
  readonly partial?: Json;
}

export type ChatUIStructuredOutputPart =
  | (ChatUIStructuredOutputBase & {
      readonly status: "streaming";
      readonly data?: never;
      readonly errorText?: never;
    })
  | (ChatUIStructuredOutputBase & {
      readonly status: "complete";
      readonly data: Json;
      readonly errorText?: never;
    })
  | (ChatUIStructuredOutputBase & {
      readonly status: "error";
      readonly data?: never;
      readonly errorText: string;
    });

export interface ChatUIImagePart {
  readonly type: "image";
  readonly id: string;
  readonly source: ChatContentSource;
  readonly metadata?: JsonObject;
}

export interface ChatUIAudioPart {
  readonly type: "audio";
  readonly id: string;
  readonly source: ChatContentSource;
  readonly metadata?: JsonObject;
}

export interface ChatUIVideoPart {
  readonly type: "video";
  readonly id: string;
  readonly source: ChatContentSource;
  readonly metadata?: JsonObject;
}

export interface ChatUIDocumentPart {
  readonly type: "document";
  readonly id: string;
  readonly source: ChatContentSource;
  readonly metadata?: JsonObject;
}

export type ChatUIMediaPart =
  | ChatUIImagePart
  | ChatUIAudioPart
  | ChatUIVideoPart
  | ChatUIDocumentPart;

interface ChatUIToolCallPartBase<TLocalPart extends ChatLocalPart = never> {
  readonly type: "tool-call";
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly rawInput?: string;
  readonly parts: readonly ChatUIPart<TLocalPart>[];
}

export type ChatUIToolCallPart<TLocalPart extends ChatLocalPart = never> =
  | (ChatUIToolCallPartBase<TLocalPart> & {
      readonly state: "input-streaming";
      readonly input?: never;
      readonly output?: never;
      readonly errorText?: never;
    })
  | (ChatUIToolCallPartBase<TLocalPart> & {
      readonly state: "input-available";
      readonly input: Json;
      readonly output?: never;
      readonly errorText?: never;
    })
  | (ChatUIToolCallPartBase<TLocalPart> & {
      readonly state: "output-available";
      readonly input: Json;
      readonly output: Json;
      readonly errorText?: never;
    })
  | (ChatUIToolCallPartBase<TLocalPart> & {
      readonly state: "output-error";
      readonly input?: Json;
      readonly output?: never;
      readonly errorText: string;
    });

export interface ChatUINestedMessagePart<TLocalPart extends ChatLocalPart = never> {
  readonly type: "message";
  readonly id: string;
  readonly message: ChatUIMessage<TLocalPart>;
}

interface ChatUIActivityPartBase<TLocalPart extends ChatLocalPart = never> {
  readonly type: "activity";
  readonly id: string;
  readonly activityType: string;
  readonly presentation: "public" | "opaque";
  readonly parts: readonly ChatUIPart<TLocalPart>[];
}

export type ChatUIActivityPart<TLocalPart extends ChatLocalPart = never> =
  | (ChatUIActivityPartBase<TLocalPart> & { readonly state: "running"; readonly data?: Json })
  | (ChatUIActivityPartBase<TLocalPart> & { readonly state: "complete"; readonly data?: Json })
  | (ChatUIActivityPartBase<TLocalPart> & { readonly state: "error"; readonly data?: Json })
  | (ChatUIActivityPartBase<TLocalPart> & { readonly state: "cancelled"; readonly data?: Json });

interface ChatUIElicitPartBase<TLocalPart extends ChatLocalPart = never> {
  readonly type: "elicit";
  readonly id: string;
  readonly elicitId: string;
  readonly bindingId: string;
  readonly key: string;
  readonly message: string;
  readonly context?: Json;
  readonly parts: readonly ChatUIPart<TLocalPart>[];
}

export type ChatUIElicitPart<TLocalPart extends ChatLocalPart = never> =
  | (ChatUIElicitPartBase<TLocalPart> & {
      readonly state: "pending";
      readonly localState?: "running" | "submitting" | "failed";
    })
  | (ChatUIElicitPartBase<TLocalPart> & {
      readonly state: "responded" | "cancelled";
      readonly localState?: never;
    });

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";
export type ChatConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type ChatRenderStatus = "loading" | "ready" | "error";
export type ChatBusyPolicy = "queue" | "drop" | "interrupt";
export type ChatQueueOverflowPolicy = "reject" | "drop-oldest";

export interface ChatQueueOptions {
  /** Action taken when a send arrives while a request is active. */
  readonly whenBusy?: ChatBusyPolicy;
  /** Maximum number of queued messages. Omit for an unbounded queue. */
  readonly maxSize?: number;
  /** `reject` rejects the incoming send; `drop-oldest` rejects the displaced send. */
  readonly onOverflow?: ChatQueueOverflowPolicy;
}

export type ChatQueueOption = ChatBusyPolicy | ChatQueueOptions;

export interface QueuedUserMessage {
  readonly id: string;
  readonly input: UserMessageInput;
  readonly createdAt: number;
}

export interface ChatHistoryError extends Error {
  readonly code:
    | "public_history_cursor_invalid"
    | "public_history_cursor_expired"
    | "public_history_frontier_changed"
    | "public_root_conflict"
    | "public_history_parent_missing";
}

export interface ChatHistoryStatus {
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly error: ChatHistoryError | null;
}

export interface ChatUISnapshot<TMessage extends ChatUIMessage<ChatLocalPart> = ChatUIMessage> {
  readonly messages: readonly TMessage[];
  readonly history: ChatHistoryStatus;
  /** Complete public application state from the latest native window. */
  readonly applicationState: Json;
  /** Latest durable admission authority; null while hydration is unresolved. */
  readonly authority: ConversationAuthority | null;
  /** Derived capability. It is never inferred from stream completion. */
  readonly canSendMessage: boolean;
  readonly status: ChatStatus;
  readonly connectionStatus: ChatConnectionStatus;
  readonly renderStatus: ChatRenderStatus;
  readonly error: Error | null;
  readonly runId: string | null;
  readonly queue: readonly QueuedUserMessage[];
}

export type UserMessageInput =
  | string
  | {
      readonly content: ChatContent;
      readonly id?: string;
      readonly metadata?: JsonObject;
    };

export interface SendMessageOptions {
  readonly whenBusy?: "queue" | "drop" | "interrupt";
  readonly forwardedProps?: Json;
}

export interface RegenerateOptions {
  readonly messageId?: string;
  readonly forwardedProps?: Json;
}

export interface ResumeEntry {
  readonly interruptId: string;
  readonly status: "resolved" | "cancelled";
  readonly payload?: Json;
}

interface ConversationCommandBase {
  readonly commandId: string;
  /** Client correlation time; the server records its own acceptance time. */
  readonly issuedAt: number;
  /** Bounded retry/admission horizon for this exact command identity. */
  readonly expiresAt: number;
  /** Durable head revision observed when the client formed this command. */
  readonly basisRevision: string | null;
}

export type ConversationCommand =
  | (ConversationCommandBase & {
      readonly type: "send-message";
      readonly messageId: string;
    })
  | (ConversationCommandBase & {
      readonly type: "regenerate";
      readonly targetMessageId?: string;
    })
  | (ConversationCommandBase & {
      readonly type: "respond-to-elicit";
      readonly logicalTurnId: string;
      readonly executionId: string;
      readonly interruptId: string;
      readonly status: "resolved" | "cancelled";
      readonly payload?: Json;
    })
  | (ConversationCommandBase & {
      readonly type: "interrupt-turn";
      readonly logicalTurnId: string;
      readonly executionId: string;
      readonly reason: string;
    });

/** Native command request; it never carries the loaded transcript. */
export interface ChatTransportRequest {
  readonly command: ConversationCommand;
  readonly clientId: string;
  readonly conversationId: string;
  readonly knownWindowToken?: import("./conversation-window.ts").WindowBasisToken;
  readonly userMessage?: ChatTransportRequestMessage;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly state?: Json;
  readonly context?: readonly { readonly description: string; readonly value: string }[];
  readonly forwardedProps?: Json;
}

export interface ChatReconnectRequest {
  readonly clientId: string;
  readonly conversationId: string;
  readonly knownWindowToken?: import("./conversation-window.ts").WindowBasisToken;
}

/** The provider-facing, serializable message form used by transport. */
export interface ChatTransportContract {
  sendMessages(
    request: ChatTransportRequest,
    signal: AbortSignal,
  ): Operation<Stream<ConversationStreamEvent, void>>;
  reconnectToStream(
    request: ChatReconnectRequest,
    signal: AbortSignal,
  ): Operation<Stream<ConversationStreamEvent, void> | null>;
  loadHistoryPage?(
    conversationId: string,
    cursor: string,
    signal: AbortSignal,
  ): Operation<import("./conversation-window.ts").PublicHistoryPage>;
  disconnect(reason?: string): Operation<void>;
}

export interface ChatTransportSnapshot {
  readonly status: ChatConnectionStatus;
  readonly error: Error | null;
}

export interface ChatTransportControl {
  getSnapshot(): ChatTransportSnapshot;
  subscribe(listener: () => void): () => void;
  reconnect(): Promise<void>;
  disconnect(reason?: string): Promise<void>;
}

export interface ClientElicitFact {
  readonly elicitId: string;
  /** AG-UI run whose durable interrupt scope owns this response. */
  readonly parentRunId?: string;
  readonly bindingId: string;
  readonly toolName: string;
  readonly key: string;
  readonly message: string;
  readonly callId: string;
  readonly seq: number;
  readonly context?: Json;
  readonly responseContract: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
  readonly placement: Omit<PublicActivityPlacement, "presentation">;
}

type ToolTransportMessage = Extract<Message, { role: "tool" }>;
export type ChatTransportRequestMessage =
  | Exclude<Message, ToolTransportMessage>
  | (ToolTransportMessage & { readonly name: string; readonly isError: boolean });

/** The transport and projection contract is the official AG-UI event union. */

export type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  CustomEvent,
  MessagesSnapshotEvent,
  RawEvent,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
};

export interface FramePipeline {
  readonly frame: Frame;
  readonly hasPending: boolean;
  readonly isDone: boolean;
  push(chunk: string): void;
  pull(): Operation<Frame>;
  flush(): Operation<Frame>;
  reset(): void;
}

export type FramePipelineFactory = (kind: "text" | "reasoning", partId: string) => FramePipeline;
