import type { Operation, Stream } from "effection";
import type { ElicitResponse, NotifyResponse } from "./message.ts";

// Re-export response types for convenience
export type { ElicitResponse, NotifyResponse } from "./message.ts";

/**
 * Transport layer interfaces.
 *
 * Transport moves bytes between environments. It has no semantic understanding.
 * The backend always initiates, the frontend always responds.
 */

/**
 * A request message sent from backend to frontend.
 */
export interface TransportRequest<T = unknown> {
  id: string;
  kind: "elicit" | "notify";
  type: string; // e.g., 'location', 'flight-selection', 'progress'
  payload: T;
}

/**
 * Backend side of the transport.
 *
 * The backend initiates all communication. It sends a message and receives
 * a stream that yields progress events and closes with the final response.
 */
export interface BackendTransport {
  /**
   * Send a message and get back a stream.
   * Stream yields progress events from frontend, closes with final response.
   *
   * @param message - The request to send to the frontend
   * @returns A stream of progress events that closes with the final response
   */
  send<TPayload, TProgress, TResponse extends ElicitResponse | NotifyResponse>(
    message: TransportRequest<TPayload>
  ): Stream<TProgress, TResponse>;
}

/**
 * An incoming message received by the frontend, with methods to respond.
 */
export interface IncomingMessage<TPayload = unknown> {
  id: string;
  kind: "elicit" | "notify";
  type: string; // e.g., 'location', 'flight-selection', 'progress'
  payload: TPayload;

  /**
   * Send incremental progress back to backend (ephemeral, not persisted)
   */
  progress(data: unknown): Operation<void>;

  /**
   * Complete with final response
   */
  respond(response: ElicitResponse | NotifyResponse): Operation<void>;
}

/**
 * Frontend side of the transport.
 *
 * The frontend receives messages and responds to them. It is purely reactive.
 */
export interface FrontendTransport {
  /**
   * A stream of incoming messages from the backend.
   * Each message has methods to send progress and respond.
   */
  messages: Stream<IncomingMessage, void>;
}

/**
 * User interrupt messages.
 *
 * These are not transport-level concerns - they are state management operations.
 * The transport delivers the signal; the state management layer interprets it.
 */
export type InterruptMessage =
  | { type: "cancel" }
  | { type: "rewind"; toMessageId: string };
