import type { DurableSemanticRecord } from "../durable-authority.ts";
import type { Json } from "../types.ts";

/**
 * Removes only backend/runtime coordination fields permitted by REQ-043.
 * Semantic record order and payloads remain byte-comparable canonical JSON.
 */
export function normalizeSemanticJournal(records: readonly DurableSemanticRecord[]): Json[] {
  return records.map((record) => ({
    sessionId: record.sessionId,
    payload: normalizePayload(record.payload),
  }));
}

function normalizePayload(payload: DurableSemanticRecord["payload"]): Json {
  if (payload.type !== "TaskOpened") {
    return structuredClone(payload) as unknown as Json;
  }
  const { catalog: _catalog, ...semantic } = payload;
  // The exact catalog digest affects authorized dispatch. Catalog contents are
  // Host-private bindings and placement route/epoch never enter this record.
  return structuredClone(semantic) as unknown as Json;
}
