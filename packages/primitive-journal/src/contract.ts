import type { Outcome } from "./primitives.ts";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Canonical JSON is both the persistence boundary and the equality rule. */
export function encode(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, encode).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      // Object.entries allocates a fresh array; retain the package ES2022 library target.
      // eslint-disable-next-line unicorn/no-array-sort
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("Expected finite JSON data");
}

export interface Identity {
  readonly executionId: string;
  readonly program: { readonly id: string; readonly version: string; readonly digest: string };
  readonly input: Json;
}

export interface AcceptedExchange {
  readonly sequence: number;
  readonly request: Json;
  readonly outcome: Outcome<Json, Json>;
}

export type RetryMode = "repeatable" | "unsafe";
export interface Attempt {
  readonly sequence: number;
  readonly number: number;
  readonly request: Json;
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
} & ({ readonly status: "running" } | { readonly status: "completed"; readonly value: Json });

/** One local writer. Commit returns only after persistence; no remote authority implied. */
export interface Journal {
  read(): Snapshot;
  begin(sequence: number, request: Json, retryMode: RetryMode): BeginAttempt;
  accept(sequence: number, request: Json, outcome: Outcome<Json, Json>): AcceptedExchange;
  complete(sequence: number, value: Json): void;
}

export function parseOutcome(value: unknown): Outcome<Json, Json> {
  encode(value);
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new Error("Invalid outcome");
  }
  if (value.ok === true && "value" in value && Object.keys(value).length === 2) {
    return { ok: true, value: value.value as Json };
  }
  if (value.ok === false && "error" in value && Object.keys(value).length === 2) {
    return { ok: false, error: value.error as Json };
  }
  throw new Error("Invalid outcome");
}

export interface RequestOccurrence {
  readonly id: string;
  readonly sequence: number;
  readonly request: Json;
  readonly status: "pending" | "accepted";
}

/** Correlation is scoped to this local journal/Identity; IDs do not authorize answers. */
export interface PendingJournal extends Journal {
  readRequests(): readonly RequestOccurrence[];
  park(sequence: number, request: Json): RequestOccurrence;
  acceptRequest(id: string, outcome: Outcome<Json, Json>): AcceptedExchange;
}

export type Activation<T> =
  | { readonly state: "parked"; readonly request: RequestOccurrence }
  | { readonly state: "completed"; readonly value: T };
