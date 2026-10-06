import type { Operation } from "effection";
import { DurableMutationInvalid as MutationInvalid } from "./codec.ts";
import type {
  AuthorityCollectionId,
  ImmutableCollectionId,
  OrderedCollectionId,
  OrderedIndexId,
} from "./collections.ts";

export { MutationInvalid as DurableMutationInvalid };

export type DurableCounter = string;
export type DurableKey = string;
export type DurableCursor = string;
export type DurablePosition = string;

export interface StoredAuthorityRecord {
  readonly collection: AuthorityCollectionId;
  readonly key: DurableKey;
  readonly revision: DurableCounter;
  readonly fence: DurableCounter | null;
  readonly value: Uint8Array;
}

export interface StoredImmutableRecord {
  readonly collection: ImmutableCollectionId;
  readonly key: DurableKey;
  readonly fingerprint: string;
  readonly value: Uint8Array;
}

export interface ImmutableClaim {
  readonly name: string;
  readonly collection: ImmutableCollectionId;
  readonly key: DurableKey;
  readonly fingerprint: string;
  readonly value: Uint8Array;
}

export interface ImmutableEnsure {
  readonly name: string;
  readonly collection: ImmutableCollectionId;
  readonly key: DurableKey;
  readonly alternateKeys?: readonly DurableKey[];
  readonly fingerprint: string;
  readonly value: Uint8Array;
}

export interface AuthorityReplacement {
  readonly name: string;
  readonly collection: AuthorityCollectionId;
  readonly key: DurableKey;
  readonly expected: {
    readonly revision: DurableCounter | null;
    readonly fence?: DurableCounter | null;
  };
  readonly next: {
    readonly revision: DurableCounter;
    readonly fence?: DurableCounter | null;
    readonly value: Uint8Array;
  };
}

export interface DurableMutation {
  readonly claim?: ImmutableClaim;
  readonly ensures: readonly ImmutableEnsure[];
  readonly authority?: AuthorityReplacement;
}

export type DurableMutationOutcome =
  | {
      readonly status: "committed";
      readonly authority: StoredAuthorityRecord | null;
      readonly ensured: Readonly<Record<string, StoredImmutableRecord>>;
    }
  | {
      readonly status: "claim_exists";
      readonly claim: string;
      readonly existing: StoredImmutableRecord;
    }
  | {
      readonly status: "authority_conflict";
      readonly authority: string;
      readonly mismatch: "fence" | "revision";
      readonly current: StoredAuthorityRecord | null;
    }
  | {
      readonly status: "immutable_conflict";
      readonly write: string;
      readonly existing: StoredImmutableRecord;
    };

export interface BoundedScan {
  readonly collection: OrderedCollectionId;
  readonly index: OrderedIndexId;
  readonly scope: DurableKey;
  readonly direction: "forward" | "backward";
  readonly after: DurableCursor | null;
  readonly through?: DurablePosition;
  readonly maxRecords: number;
  readonly maxStoredBytes: number;
}

export interface StoredScanRecord extends StoredImmutableRecord {
  readonly position: DurablePosition;
  readonly storedBytes: number;
}

export interface StoredScanPage {
  readonly records: readonly StoredScanRecord[];
  readonly nextCursor: DurableCursor | null;
}

export interface ChangeWait {
  readonly collection: AuthorityCollectionId;
  readonly key: DurableKey;
  readonly afterRevision: DurableCounter;
  readonly timeoutMs: number;
}

export interface DurableKernel {
  readAuthority(
    collection: AuthorityCollectionId,
    key: DurableKey,
  ): Operation<StoredAuthorityRecord | null>;
  readImmutable(
    collection: ImmutableCollectionId,
    key: DurableKey,
  ): Operation<StoredImmutableRecord | null>;
  scan(request: BoundedScan): Operation<StoredScanPage>;
  /** Wake-up hint; callers must read authority before and after waiting.
   * Backends without notifications may wait the full timeout without polling.
   */
  waitForChange(request: ChangeWait): Operation<void>;
  apply(mutation: DurableMutation): Operation<DurableMutationOutcome>;
}

export type DurableKernelErrorCode =
  | "durable_kernel_unavailable"
  | "durable_kernel_closed"
  | "durable_kernel_transaction_failed"
  | "durable_kernel_integer_out_of_range"
  | "durable_kernel_schema_incompatible"
  | "durable_kernel_response_invalid"
  | "durable_kernel_persisted_data_invalid";

/**
 * Backend-neutral transaction seam. A kernel implementation requires a
 * transactional executor over its native database handle; isolation choices
 * (SQLite `BEGIN IMMEDIATE`, Postgres isolation levels and locks) belong to
 * the backend binding that implements this interface.
 */
export interface TransactionRunner<TDatabase = unknown> {
  transaction<T>(body: (transaction: TDatabase) => T | Promise<T>): Operation<T>;
}

export class DurableKernelError extends Error {
  constructor(
    readonly code: DurableKernelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DurableKernelError";
  }
}

export const DURABLE_MUTATION_MAX_ENSURES = 256;
export const DURABLE_MUTATION_MAX_BYTES = 16 * 1024 * 1024;
export const DURABLE_SCAN_MAX_RECORDS = 1024;
export const DURABLE_SCAN_MAX_BYTES = 16 * 1024 * 1024;
