import type { Operation, Stream } from "effection";
import type {
  AGUIEvent,
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
import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { Frame } from "./frame.ts";

/** A generic local part supplied by a frontend adapter. */
export interface ChatLocalPart {
  readonly type: string;
  readonly id: string;
}

export interface ChatMessage<TLocalPart extends ChatLocalPart = never> {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly parts: readonly ChatPart<TLocalPart>[];
  readonly metadata?: Readonly<Record<string, Json>>;
}

export type ChatPart<TLocalPart extends ChatLocalPart = never> =
  | TextPart
  | ReasoningPart
  | ToolCallPart<TLocalPart>
  | NestedMessagePart<TLocalPart>
  | ActivityPart<TLocalPart>
  | ElicitPart<TLocalPart>
  | TLocalPart;

export interface TextPart {
  readonly type: "text";
  readonly id: string;
  readonly text: string;
  readonly state: "streaming" | "done";
  readonly frame: Frame;
  readonly rendered: string;
}

export interface ReasoningPart {
  readonly type: "reasoning";
  readonly id: string;
  readonly text: string;
  readonly state: "streaming" | "done";
  readonly frame: Frame;
  readonly rendered: string;
}

export interface ToolCallPart<TLocalPart extends ChatLocalPart = never> {
  readonly type: "tool-call";
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly state: "input-streaming" | "input-available" | "output-available" | "output-error";
  readonly input?: Json;
  readonly rawInput?: string;
  readonly output?: Json;
  readonly errorText?: string;
  readonly parts: readonly ChatPart<TLocalPart>[];
}

export interface NestedMessagePart<TLocalPart extends ChatLocalPart = never> {
  readonly type: "message";
  readonly id: string;
  readonly message: ChatMessage<TLocalPart>;
}

export interface ActivityPart<TLocalPart extends ChatLocalPart = never> {
  readonly type: "activity";
  readonly id: string;
  readonly activityType: string;
  readonly state: "running" | "complete" | "error" | "cancelled";
  readonly data?: Json;
  readonly presentation: "public" | "opaque";
  readonly parts: readonly ChatPart<TLocalPart>[];
}

export interface ElicitPart<TLocalPart extends ChatLocalPart = never> {
  readonly type: "elicit";
  readonly id: string;
  readonly elicitId: string;
  readonly bindingId: string;
  readonly key: string;
  readonly message: string;
  readonly context?: Json;
  readonly state: "pending" | "responded" | "cancelled";
  readonly localState?: "running" | "submitting" | "failed";
  readonly parts: readonly ChatPart<TLocalPart>[];
}

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";
export type ChatConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type ChatRenderStatus = "loading" | "ready" | "error";

export interface QueuedUserMessage {
  readonly id: string;
  readonly input: UserMessageInput;
}

export interface ChatSnapshot<TMessage extends ChatMessage<ChatLocalPart> = ChatMessage> {
  readonly messages: readonly TMessage[];
  readonly status: ChatStatus;
  readonly connectionStatus: ChatConnectionStatus;
  readonly renderStatus: ChatRenderStatus;
  readonly error: Error | null;
  readonly queuedMessages: readonly QueuedUserMessage[];
}

export type UserInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: string; readonly [key: string]: Json };

export type UserMessageInput =
  | {
      readonly text: string;
      readonly id?: string;
      readonly metadata?: Readonly<Record<string, Json>>;
    }
  | {
      readonly parts: readonly UserInputPart[];
      readonly id?: string;
      readonly metadata?: Readonly<Record<string, Json>>;
    };

export interface SendMessageOptions {
  readonly whenBusy?: "queue" | "drop" | "interrupt";
  readonly forwardedProps?: Json;
}

export interface RegenerateOptions {
  readonly messageId?: string;
  readonly forwardedProps?: Json;
}

export type ChatSendTrigger = "submit-message" | "regenerate-message" | "cancel-run";

export interface ResumeEntry {
  readonly interruptId: string;
  readonly status: "resolved" | "cancelled";
  readonly payload?: Json;
}

export interface ChatSendRequest {
  readonly trigger: ChatSendTrigger;
  readonly clientId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly messageId?: string;
  readonly messages: readonly ChatWireMessage[];
  readonly state: Json;
  readonly context: readonly { readonly description: string; readonly value: string }[];
  readonly forwardedProps: Json;
  readonly resume?: readonly ResumeEntry[];
  readonly cancellationReason?: string;
}

export interface ChatReconnectRequest {
  readonly clientId: string;
  readonly conversationId: string;
  readonly cursor?: number;
}

/** The provider-facing, serializable message form used by transport. */
export interface ChatTransportContract {
  sendMessages(
    request: ChatSendRequest,
    signal: AbortSignal,
  ): Operation<Stream<ChatStreamEvent, void>>;
  reconnectToStream(
    request: ChatReconnectRequest,
    signal: AbortSignal,
  ): Operation<Stream<ChatStreamEvent, void> | null>;
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

export interface PublicActivityPlacement {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
  readonly presentation: "public" | "opaque";
}

export interface PublicMessageActivityNode extends PublicActivityPlacement {
  readonly kind: "message";
  readonly state: "streaming" | "done";
  readonly publicData: {
    readonly kind: "message";
    readonly messageId: string;
    readonly role: ChatMessage["role"];
  };
}

export interface PublicToolActivityData {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly name: string;
  readonly rawInput?: string;
  readonly input?: Json;
  readonly output?: Json;
  readonly errorText?: string;
}

export interface PublicToolActivityNode extends PublicActivityPlacement {
  readonly kind: "tool-call";
  readonly state: "input-streaming" | "input-available" | "output-available" | "output-error";
  readonly publicData: PublicToolActivityData;
}

export interface PublicGenericActivityNode extends PublicActivityPlacement {
  readonly kind: "activity";
  readonly state: "running" | "complete" | "error" | "cancelled";
  readonly publicData?: {
    readonly kind: "activity";
    readonly activityType: string;
    readonly data?: Json;
  };
}

export interface PublicElicitActivityData {
  readonly kind: "elicit";
  readonly elicitId: string;
  readonly bindingId: string;
  readonly key: string;
  readonly message: string;
  readonly context?: Json;
  readonly responseContract: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
  readonly toolName: string;
  readonly callId: string;
  readonly producerSequence: number;
}

export interface PublicElicitActivityNode extends PublicActivityPlacement {
  readonly kind: "elicit";
  readonly state: "pending" | "responded" | "cancelled";
  readonly publicData: PublicElicitActivityData;
}

export interface ClientElicitFact {
  readonly elicitId: string;
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

/** A parsed public node is legal by construction: each kind owns its states and data. */
export type PublicActivityNode =
  | PublicMessageActivityNode
  | PublicToolActivityNode
  | PublicGenericActivityNode
  | PublicElicitActivityNode;

export type PublicActivityData = NonNullable<PublicActivityNode["publicData"]>;

export interface SweatpantsPublicActivity {
  readonly version: 1;
  readonly node: PublicActivityNode;
}

export type JsonPatchOperation = {
  readonly op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  readonly path: string;
  readonly from?: string;
  readonly value?: Json;
};

export type ChatWireMessage = Message;

/** The transport and projection contract is the official AG-UI event union. */
export type ChatStreamEvent = AGUIEvent;
export type ChatEvent = ChatStreamEvent;

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
