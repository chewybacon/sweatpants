import type {
  DurableMutation,
  DurableMutationOutcome,
  ImmutableEnsure,
  StoredAuthorityRecord,
  StoredImmutableRecord,
} from "./contract.ts";
import { authorityMismatch, validateMutationStructure } from "./validation.ts";

export interface MutationPreconditions {
  readonly claim: StoredImmutableRecord | null;
  readonly authority: StoredAuthorityRecord | null;
}

type MutationConflict = Exclude<DurableMutationOutcome, { status: "committed" }>;

/** Claim replay takes precedence over stale authority and immutable conflicts.
 * Backends can check this before loading ensure candidates to avoid wasted reads.
 */
export function evaluateMutationPreconditions(
  mutation: DurableMutation,
  snapshot: MutationPreconditions,
): MutationConflict | null {
  if (mutation.claim && snapshot.claim) {
    return { status: "claim_exists", claim: mutation.claim.name, existing: snapshot.claim };
  }
  if (mutation.authority) {
    const mismatch = authorityMismatch(mutation.authority, snapshot.authority);
    if (mismatch) {
      return {
        status: "authority_conflict",
        authority: mutation.authority.name,
        mismatch,
        current: snapshot.authority,
      };
    }
  }
  return null;
}

export interface MutationSnapshot extends MutationPreconditions {
  /** Resolve primary and alternate keys. Repeated aliases of one record are allowed. */
  readonly candidates: (ensure: ImmutableEnsure) => readonly StoredImmutableRecord[];
}

export interface MutationPlan {
  readonly status: "ready";
  readonly inserts: readonly ImmutableEnsure[];
  /** Publish only after the backend atomically commits the plan against its snapshot. */
  readonly outcome: Extract<DurableMutationOutcome, { status: "committed" }>;
}

/** Allows adapters that read candidates incrementally to stop at the first conflict. */
export function evaluateImmutableEnsure(
  mutation: DurableMutation,
  ensure: ImmutableEnsure,
  candidates: readonly StoredImmutableRecord[],
): Extract<MutationConflict, { status: "immutable_conflict" }> | null {
  const existing = candidates[0];
  const collision = candidates.find((candidate) => candidate.key !== existing?.key);
  if (collision) {
    return { status: "immutable_conflict", write: ensure.name, existing: collision };
  }
  if (
    existing &&
    (existing.fingerprint !== ensure.fingerprint ||
      (mutation.authority !== undefined && existing.key !== ensure.key))
  ) {
    return { status: "immutable_conflict", write: ensure.name, existing };
  }
  return null;
}

/** Pure decisions only. The backend owns snapshot isolation, write atomicity and retries. */
export function evaluateMutation(
  mutation: DurableMutation,
  snapshot: MutationSnapshot,
): MutationPlan | MutationConflict {
  validateMutationStructure(mutation);
  const preconditionConflict = evaluateMutationPreconditions(mutation, snapshot);
  if (preconditionConflict) {
    return preconditionConflict;
  }

  const ensured = new Map<string, StoredImmutableRecord>();
  const inserts: ImmutableEnsure[] = [];
  for (const ensure of mutation.ensures) {
    const candidates = snapshot.candidates(ensure);
    const conflict = evaluateImmutableEnsure(mutation, ensure, candidates);
    if (conflict) {
      return conflict;
    }
    const existing = candidates[0];
    ensured.set(
      ensure.name,
      existing ?? {
        collection: ensure.collection,
        key: ensure.key,
        fingerprint: ensure.fingerprint,
        value: new Uint8Array(ensure.value),
      },
    );
    if (!existing) {
      inserts.push(ensure);
    }
  }
  const authority = mutation.authority
    ? {
        collection: mutation.authority.collection,
        key: mutation.authority.key,
        revision: mutation.authority.next.revision,
        fence: mutation.authority.next.fence ?? snapshot.authority?.fence ?? null,
        value: new Uint8Array(mutation.authority.next.value),
      }
    : null;
  return {
    status: "ready",
    inserts,
    outcome: { status: "committed", authority, ensured: Object.fromEntries(ensured) },
  };
}
