import type { Operation, Stream } from "effection";
import type { ElicitResponse, NotifyResponse } from "./message.ts";

export type { ElicitResponse, NotifyResponse } from "./message.ts";

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
// Wire Message Types
// ============================================================================

/**
 * A request message sent from Principal to Operative.
 */
export interface TransportRequest<TPayload = unknown> {
  id: string;
  kind: "elicit" | "notify";
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
 */
export interface ResponseMessage {
  type: "response";
  id: string;
  response: ElicitResponse | NotifyResponse;
}

/**
 * Messages that can be received by the Principal (from Operative).
 */
export type PrincipalIncoming = ProgressMessage | ResponseMessage;

/**
 * Messages that can be sent by the Principal (to Operative).
 */
export type PrincipalOutgoing = TransportRequest;

/**
 * Messages that can be received by the Operative (from Principal).
 */
export type OperativeIncoming = TransportRequest;

/**
 * Messages that can be sent by the Operative (to Principal).
 */
export type OperativeOutgoing = ProgressMessage | ResponseMessage;

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
// Interrupt Messages (for future use)
// ============================================================================

export type InterruptMessage =
  | { type: "cancel" }
  | { type: "rewind"; toMessageId: string };
