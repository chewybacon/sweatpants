import type { Outcome } from "./computation.ts";
import type { ReadonlyJson } from "./json.ts";

export interface Identity {
  readonly executionId: string;
  readonly program: { readonly id: string; readonly version: string; readonly digest: string };
  readonly input: ReadonlyJson;
}

export interface AcceptedExchange {
  readonly sequence: number;
  readonly request: ReadonlyJson;
  readonly outcome: Outcome<ReadonlyJson, ReadonlyJson>;
}

export type RetryMode = "repeatable" | "unsafe";
export interface Attempt {
  readonly sequence: number;
  readonly number: number;
  readonly request: ReadonlyJson;
  readonly retryMode: RetryMode;
  readonly status: "started" | "unknown" | "accepted";
}

export type BeginAttempt =
  | { readonly kind: "started"; readonly attempt: Attempt }
  | { readonly kind: "uncertain"; readonly attempt: Attempt };

export type Snapshot = {
  readonly identity: Identity;
  readonly entries: readonly AcceptedExchange[];
  readonly attempts: readonly Attempt[];
} & (
  | { readonly status: "running" }
  | { readonly status: "completed"; readonly value: ReadonlyJson }
  | { readonly status: "interrupting" | "cancelled" | "failed"; readonly reason: string }
);

/** One local writer. Commit returns only after persistence; no remote authority implied. */
export interface Journal {
  read(): Snapshot;
  begin(sequence: number, request: ReadonlyJson, retryMode: RetryMode): BeginAttempt;
  accept(
    sequence: number,
    request: ReadonlyJson,
    outcome: Outcome<ReadonlyJson, ReadonlyJson>,
  ): AcceptedExchange;
  complete(sequence: number, value: ReadonlyJson): void;
}

export interface RequestOccurrence {
  readonly id: string;
  readonly sequence: number;
  readonly request: ReadonlyJson;
  readonly status: "pending" | "accepted";
}

/** Correlation is scoped to this local journal/Identity; IDs do not authorize answers. */
export interface PendingJournal extends Journal {
  /** Read at most one accepted exchange, without scanning history or prefetching.
   * Absent means not accepted yet. Full replay/integrity validation remains read().
   */
  readAccepted(sequence: number): AcceptedExchange | undefined;
  readRequests(): readonly RequestOccurrence[];
  park(sequence: number, request: ReadonlyJson): RequestOccurrence;
  acceptRequest(id: string, outcome: Outcome<ReadonlyJson, ReadonlyJson>): AcceptedExchange;
}

export type Activation<T> =
  | { readonly state: "parked"; readonly request: RequestOccurrence }
  | { readonly state: "completed"; readonly value: T };
