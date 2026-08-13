import type {
  BoundedScan,
  ChangeWait,
  DurableKernel,
  DurableMutation,
  DurableMutationOutcome,
  StoredAuthorityRecord,
  StoredImmutableRecord,
  StoredScanPage,
} from "./contract.ts";
import type { AuthorityCollectionId, ImmutableCollectionId } from "./collections.ts";
import type { Operation } from "effection";

export interface DurableKernelMiddleware {
  readAuthority?(
    collection: AuthorityCollectionId,
    key: string,
    next: () => Operation<StoredAuthorityRecord | null>,
  ): Operation<StoredAuthorityRecord | null>;
  readImmutable?(
    collection: ImmutableCollectionId,
    key: string,
    next: () => Operation<StoredImmutableRecord | null>,
  ): Operation<StoredImmutableRecord | null>;
  scan?(request: BoundedScan, next: () => Operation<StoredScanPage>): Operation<StoredScanPage>;
  waitForChange?(request: ChangeWait, next: () => Operation<void>): Operation<void>;
  apply?(
    mutation: DurableMutation,
    next: () => Operation<DurableMutationOutcome>,
  ): Operation<DurableMutationOutcome>;
}

/** Wrap physical kernel work without making middleware part of correctness. */
export function withDurableKernelMiddleware(
  inner: DurableKernel,
  middleware: DurableKernelMiddleware,
): DurableKernel {
  return {
    *readAuthority(collection, key): Operation<StoredAuthorityRecord | null> {
      if (middleware.readAuthority) {
        return yield* middleware.readAuthority(collection, key, () =>
          inner.readAuthority(collection, key),
        );
      }
      return yield* inner.readAuthority(collection, key);
    },
    *readImmutable(collection, key): Operation<StoredImmutableRecord | null> {
      if (middleware.readImmutable) {
        return yield* middleware.readImmutable(collection, key, () =>
          inner.readImmutable(collection, key),
        );
      }
      return yield* inner.readImmutable(collection, key);
    },
    *scan(request): Operation<StoredScanPage> {
      if (middleware.scan) {
        return yield* middleware.scan(request, () => inner.scan(request));
      }
      return yield* inner.scan(request);
    },
    *waitForChange(request): Operation<void> {
      if (middleware.waitForChange) {
        return yield* middleware.waitForChange(request, () => inner.waitForChange(request));
      }
      return yield* inner.waitForChange(request);
    },
    *apply(mutation): Operation<DurableMutationOutcome> {
      if (middleware.apply) {
        return yield* middleware.apply(mutation, () => inner.apply(mutation));
      }
      return yield* inner.apply(mutation);
    },
  };
}
