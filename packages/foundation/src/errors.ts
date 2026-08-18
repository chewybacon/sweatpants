import type { Json } from "./json.ts";

/**
 * Evidence for a rejected write against an authoritative cell.
 *
 * `expected` is the caller-presented value: its proposed identity, or the
 * revision, fence, or state it believes is current. `observed` is the value
 * the authority actually holds (`null` when the cell is absent).
 *
 * The guard taxonomy is intentionally broader than the first adoption. The
 * identity guard covers command, model-context, resolution, idempotency, and
 * immutable-content mismatches. Revision, fence, and state guards cover the
 * corresponding CAS, ownership, and state-precondition failures. Domain
 * packages retain their own stable status and error codes; this is only the
 * shared evidence vocabulary.
 *
 * Evidence is computed at rejection time. It is not, by itself, a persistence
 * or transport contract.
 */
export type ConflictEvidence = {
  readonly domain: string;
  readonly key: string;
  readonly guard: "identity" | "revision" | "fence" | "state";
  readonly expected: string;
  readonly observed: string | null;
};

/** Conflict evidence for a same-key, different-identity rejection. */
export type IdentityConflict = ConflictEvidence & { readonly guard: "identity" };

/** Safe error DTO permitted across portable persistence and transport boundaries. */
export type SerializedApplicationError = { code: string; message: string; details?: Json };
