import type { Operation, Stream } from "effection";
import type { ElicitResponse, NotifyResponse, SampleResponse } from "./message.ts";

export type { ElicitResponse, NotifyResponse, SampleResponse } from "./message.ts";

// ============================================================================
// Base Transport Interface
// ============================================================================

/**
 * A bidirectional transport that can send and receive messages.
 * Extends Stream to allow consuming received messages.
 */
export interface Transport<TSend, TReceive> extends Stream<TReceive, void> {
  send(message: TSend): Operation<void>;
}

// ============================================================================
// Request Kinds
// ============================================================================

/**
 * The kind of request being made. Determines the response pattern.
 * - elicit: Request user input, can be accepted/declined/cancelled/denied
 * - notify: Send notification, receives acknowledgment
 * - sample: Request LLM completion, receives content or error
 */
export type RequestKind = "elicit" | "notify" | "sample";

// ============================================================================
// Response Mapping
// ============================================================================

/**
 * Maps request kind to its corresponding response type.
 * Enables type-safe correlation between requests and responses.
 */
export type ResponseByKind = {
  elicit: ElicitResponse;
  notify: NotifyResponse;
  sample: SampleResponse;
};

// ============================================================================
// Wire Message Types
// ============================================================================

/**
 * A request message sent from Principal to Operative.
 * Generic on K to enable type-safe response inference.
 */
export interface TransportRequest<K extends RequestKind = RequestKind, TPayload = unknown> {
  id: string;
  kind: K;
  type: string;
  payload: TPayload;
}

/**
 * A progress update sent from Operative to Principal.
 */
export interface ProgressMessage<TData = unknown> {
  type: "progress";
  id: string;
  data: TData;
}

/**
 * A final response sent from Operative to Principal.
 * Includes kind field to enable discrimination and type-safe response access.
 */
export interface ResponseMessage<K extends RequestKind = RequestKind> {
  type: "response";
  id: string;
  kind: K;
  response: ResponseByKind[K];
}

// ============================================================================
// Principal/Operative Message Types
// ============================================================================

/**
 * Messages that can be received by the Principal (from Operative).
 */
export type PrincipalIncoming = ProgressMessage | ResponseMessage<RequestKind>;

/**
 * Messages that can be sent by the Principal (to Operative).
 */
export type PrincipalOutgoing = TransportRequest<RequestKind>;

/**
 * Messages that can be received by the Operative (from Principal).
 */
export type OperativeIncoming = TransportRequest<RequestKind>;

/**
 * Messages that can be sent by the Operative (to Principal).
 */
export type OperativeOutgoing = ProgressMessage | ResponseMessage<RequestKind>;

// ============================================================================
// Concrete Transport Types
// ============================================================================

/**
 * Transport used by the Principal (agent) side.
 * Sends requests, receives progress/responses.
 */
export type PrincipalTransport = Transport<PrincipalOutgoing, PrincipalIncoming>;

/**
 * Transport used by the Operative (UI) side.
 * Receives requests, sends progress/responses.
 */
export type OperativeTransport = Transport<OperativeOutgoing, OperativeIncoming>;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a progress message.
 */
export function isProgressMessage(msg: PrincipalIncoming): msg is ProgressMessage {
  return msg.type === "progress";
}

/**
 * Check if a message is a response message.
 */
export function isResponseMessage(msg: PrincipalIncoming): msg is ResponseMessage<RequestKind> {
  return msg.type === "response";
}

/**
 * Check if a response message is for an elicit request.
 */
export function isElicitResponse(msg: ResponseMessage<RequestKind>): msg is ResponseMessage<"elicit"> {
  return msg.kind === "elicit";
}

/**
 * Check if a response message is for a notify request.
 */
export function isNotifyResponse(msg: ResponseMessage<RequestKind>): msg is ResponseMessage<"notify"> {
  return msg.kind === "notify";
}

/**
 * Check if a response message is for a sample request.
 */
export function isSampleResponse(msg: ResponseMessage<RequestKind>): msg is ResponseMessage<"sample"> {
  return msg.kind === "sample";
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a response message with type-safe kind enforcement.
 * Helps ensure kind field is always included during construction.
 */
export function createResponseMessage<K extends RequestKind>(
  message: ResponseMessage<K>
): ResponseMessage<K> {
  return message;
}

// ============================================================================
// Interrupt Messages (for future use)
// ============================================================================

export type InterruptMessage =
  | { type: "cancel" }
  | { type: "rewind"; toMessageId: string };
