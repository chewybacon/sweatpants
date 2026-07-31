import type { ElicitRequestStreamEvent } from "./streaming.ts";

/** Facts established by the transport after the response stream is consumed. */
export interface ChatTransportReceipt {
  readonly conversationId?: string;
}

/**
 * Semantic outcome established by the Chat Core projection after the canonical
 * event stream has drained into session history.
 *
 * This deliberately carries no reconstructed conversation state or duplicate
 * tool/result DTOs. The projection retains those facts for the next request;
 * callers only need to know whether they may continue or answer an interrupt.
 */
export type ChatTurnSettlement =
  | {
      readonly outcome: "complete";
    }
  | {
      readonly outcome: "interrupt";
      readonly pendingElicitations: readonly ElicitRequestStreamEvent[];
    };
