import { stableTupleHash } from "@sweatpants/foundation";
import type { DurableSemanticRecord } from "../semantic-record.ts";
import type { Json } from "@sweatpants/foundation";

/**
 * Removes only backend and activation coordination fields from the real
 * journal authority record union. The exhaustive switch intentionally fails
 * typechecking when the authority adds a record without a normalization
 * decision.
 */
export function normalizeSemanticJournal(records: readonly DurableSemanticRecord[]): Json[] {
  return records
    .filter(
      (record) =>
        record.payload.type !== "AdvancementBound" && record.payload.type !== "AdvancementReleased",
    )
    .map((record) => ({
      sessionId: record.sessionId,
      payload: normalizePayload(record.payload),
    }));
}

/** Domain-separated digest of the normalized real authority journal. */
export function normalizedSemanticJournalDigest(records: readonly DurableSemanticRecord[]): string {
  return stableTupleHash([
    "sweatpants.semantic-journal-normalizer.v1",
    normalizeSemanticJournal(records),
  ]);
}

function normalizePayload(payload: DurableSemanticRecord["payload"]): Json {
  switch (payload.type) {
    case "TaskOpened": {
      const { catalog: _catalog, ...semantic } = payload;
      // The catalog digest is semantic dispatch identity. Catalog contents are
      // Host-private bindings and placement route/epoch never enter this record.
      return structuredClone(semantic) as unknown as Json;
    }
    case "AdvancementBound": {
      const { ownerId: _owner, expiresAtMs: _expiry, ...semantic } = payload;
      return structuredClone(semantic) as unknown as Json;
    }
    case "AdvancementReleased":
    case "PullRequested":
    case "ModelContextPrepared":
    case "AssistantPartialAccepted":
    case "AttemptStarted":
    case "AttemptDetached":
    case "AttemptAbandoned":
    case "AttemptSuperseded":
    case "PullIndeterminate":
    case "PullResolved":
    case "DurableEmission":
    case "RaceWinnerSelected":
    case "CancellationRequested":
    case "CancellationPartialDiscarded":
    case "AttemptOutcomeUnknown":
    case "CleanupSkipped":
    case "TaskOrphaned":
    case "TaskClosed":
    case "ForkGroupOpened":
    case "ForkGroupBreached":
    case "ForkGroupResolved":
    case "ForkGroupOrphaned":
    case "PeerDelegationCommitted":
      return structuredClone(payload) as unknown as Json;
    default:
      return assertNever(payload);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unclassified durable journal record: ${JSON.stringify(value)}`);
}
