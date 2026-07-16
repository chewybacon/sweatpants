import type { DurableSemanticRecord } from "../durable-authority.ts";
import type { Json } from "../types.ts";

/**
 * Removes only backend/runtime coordination fields permitted by REQ-043.
 * Semantic record order and payloads remain byte-comparable canonical JSON.
 */
export function normalizeSemanticJournal(records: readonly DurableSemanticRecord[]): Json[] {
  return records.map((record) => ({
    sessionId: record.sessionId,
    payload: structuredClone(record.payload) as unknown as Json,
  }));
}
