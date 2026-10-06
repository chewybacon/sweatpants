import { call, sleep, type Operation } from "effection";
import type {
  BoundedScan,
  DurableKernel,
  DurableMutation,
  DurableMutationOutcome,
  StoredAuthorityRecord,
  StoredImmutableRecord,
  StoredScanPage,
} from "./contract.ts";
import { decodeDurableKey, durableKey } from "./codec.ts";
import { seek } from "./ordered-seek.ts";
import {
  authorityMismatch,
  parseCounter,
  validateMutationStructure,
  validateScan,
} from "./validation.ts";

interface ImmutableEntry {
  readonly record: StoredImmutableRecord;
  readonly aliases: readonly string[];
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function cloneAuthority(value: StoredAuthorityRecord | null): StoredAuthorityRecord | null {
  return value === null ? null : { ...value, value: cloneBytes(value.value) };
}

function cloneImmutable(value: StoredImmutableRecord): StoredImmutableRecord {
  return { ...value, value: cloneBytes(value.value) };
}

function identity(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}

export function createMemoryDurableKernel(): DurableKernel {
  const authorities = new Map<string, StoredAuthorityRecord>();
  const immutableAliases = new Map<string, ImmutableEntry>();
  type IndexedRecord = { record: StoredImmutableRecord; position: string; numeric: bigint };
  // Keep ordered identities at write time: reads seek O(log n), then visit only
  // the requested page in this scope. Payloads remain shared until returned.
  const indexes = new Map<string, IndexedRecord[]>();

  function positions(entry: ImmutableEntry): { scope: string; value: IndexedRecord }[] {
    const collection = entry.record.collection;
    const task =
      collection === "execution-journal-segments" || collection === "execution-replay-segments";
    const root = collection === "conversation-public-root-index";
    if (
      !task &&
      !root &&
      collection !== "conversation-public-segments" &&
      collection !== "conversation-terminal-segments"
    )
      return [];
    const found = new Map<string, IndexedRecord>();
    for (const alias of entry.aliases) {
      const parts = decodeDurableKey(alias);
      if (parts.length < (task ? 4 : root ? 2 : 3)) continue;
      const scope = identity(collection, durableKey(...parts.slice(0, task ? 2 : 1)));
      if (found.has(scope)) continue;
      const position = parts[task ? 2 : 1]!;
      found.set(scope, {
        record: entry.record,
        position,
        numeric: parseCounter(position, "stored scan position"),
      });
    }
    return [...found].map(([scope, value]) => ({ scope, value }));
  }

  function insert(scope: string, value: IndexedRecord) {
    let records = indexes.get(scope);
    if (!records) {
      records = [];
      indexes.set(scope, records);
    }
    const offset = seek(records.length, (index) => {
      const existing = records![index]!;
      return (
        existing.numeric < value.numeric ||
        (existing.numeric === value.numeric &&
          existing.record.key.localeCompare(value.record.key) < 0)
      );
    });
    records.splice(offset, 0, value);
  }

  function readAuthority(collection: Parameters<DurableKernel["readAuthority"]>[0], key: string) {
    return cloneAuthority(authorities.get(identity(collection, key)) ?? null);
  }

  function readImmutable(collection: Parameters<DurableKernel["readImmutable"]>[0], key: string) {
    const entry = immutableAliases.get(identity(collection, key));
    return entry === undefined ? null : cloneImmutable(entry.record);
  }

  function apply(mutation: DurableMutation): DurableMutationOutcome {
    validateMutationStructure(mutation);

    if (mutation.claim) {
      const existing = readImmutable(mutation.claim.collection, mutation.claim.key);
      if (existing !== null) {
        return { status: "claim_exists", claim: mutation.claim.name, existing };
      }
    }

    let current: StoredAuthorityRecord | null = null;
    if (mutation.authority) {
      current = readAuthority(mutation.authority.collection, mutation.authority.key);
      const mismatch = authorityMismatch(mutation.authority, current);
      if (mismatch !== null) {
        return {
          status: "authority_conflict",
          authority: mutation.authority.name,
          mismatch,
          current,
        };
      }
    }

    const resolved = new Map<string, StoredImmutableRecord>();
    for (const ensure of mutation.ensures) {
      const keys = [ensure.key, ...(ensure.alternateKeys ?? [])];
      let existing: StoredImmutableRecord | null = null;
      for (const key of keys) {
        const candidate = readImmutable(ensure.collection, key);
        if (candidate !== null) {
          if (existing !== null && existing.key !== candidate.key) {
            return { status: "immutable_conflict", write: ensure.name, existing: candidate };
          }
          existing = candidate;
        }
      }
      if (existing !== null) {
        if (
          existing.fingerprint !== ensure.fingerprint ||
          (mutation.authority !== undefined && existing.key !== ensure.key)
        ) {
          return { status: "immutable_conflict", write: ensure.name, existing };
        }
        resolved.set(ensure.name, existing);
      }
    }

    const pending = mutation.ensures
      .filter((ensure) => !resolved.has(ensure.name))
      .map((ensure) => {
        const record: StoredImmutableRecord = {
          collection: ensure.collection,
          key: ensure.key,
          fingerprint: ensure.fingerprint,
          value: cloneBytes(ensure.value),
        };
        const entry = { record, aliases: [ensure.key, ...(ensure.alternateKeys ?? [])] };
        return { name: ensure.name, entry, positions: positions(entry) };
      });

    const claimEntry = mutation.claim
      ? {
          record: {
            collection: mutation.claim.collection,
            key: mutation.claim.key,
            fingerprint: mutation.claim.fingerprint,
            value: cloneBytes(mutation.claim.value),
          },
          aliases: [mutation.claim.key],
        }
      : null;
    const claimPositions = claimEntry ? positions(claimEntry) : [];

    if (claimEntry) {
      const record = claimEntry.record;
      immutableAliases.set(identity(record.collection, record.key), claimEntry);
      for (const position of claimPositions) insert(position.scope, position.value);
    }

    for (const item of pending) {
      for (const key of item.entry.aliases)
        immutableAliases.set(identity(item.entry.record.collection, key), item.entry);
      for (const position of item.positions) insert(position.scope, position.value);
      resolved.set(item.name, cloneImmutable(item.entry.record));
    }

    let authority: StoredAuthorityRecord | null = null;
    if (mutation.authority) {
      authority = {
        collection: mutation.authority.collection,
        key: mutation.authority.key,
        revision: mutation.authority.next.revision,
        fence: mutation.authority.next.fence ?? current?.fence ?? null,
        value: cloneBytes(mutation.authority.next.value),
      };
      authorities.set(identity(authority.collection, authority.key), authority);
      authority = cloneAuthority(authority);
    }

    return {
      status: "committed",
      authority,
      ensured: Object.fromEntries(
        [...resolved].map(([name, record]) => [name, cloneImmutable(record)]),
      ),
    };
  }

  function scan(request: BoundedScan): StoredScanPage {
    validateScan(request);
    const records = indexes.get(identity(request.collection, request.scope)) ?? [];
    const after = request.after === null ? null : parseCounter(request.after, "scan cursor");
    const through =
      request.through === undefined ? null : parseCounter(request.through, "scan frontier");
    const selected = [];
    let bytes = 0;
    let hasMore = false;
    const forward = request.direction === "forward";
    const start =
      after === null
        ? forward
          ? 0
          : records.length - 1
        : forward
          ? seek(records.length, (index) => records[index]!.numeric <= after)
          : seek(records.length, (index) => records[index]!.numeric < after) - 1;
    for (let index = start; index >= 0 && index < records.length; index += forward ? 1 : -1) {
      const candidate = records[index]!;
      if (through !== null && (forward ? candidate.numeric > through : candidate.numeric < through))
        break;
      const storedBytes = candidate.record.value.byteLength;
      if (selected.length >= request.maxRecords || bytes + storedBytes > request.maxStoredBytes) {
        hasMore = true;
        break;
      }
      selected.push({
        ...cloneImmutable(candidate.record),
        position: candidate.position,
        storedBytes,
      });
      bytes += storedBytes;
    }
    return {
      records: selected,
      nextCursor: hasMore && selected.length > 0 ? selected.at(-1)!.position : null,
    };
  }

  return {
    *readAuthority(collection, key): Operation<StoredAuthorityRecord | null> {
      return yield* call(() => readAuthority(collection, key));
    },
    *readImmutable(collection, key): Operation<StoredImmutableRecord | null> {
      return yield* call(() => readImmutable(collection, key));
    },
    *scan(request): Operation<StoredScanPage> {
      return yield* call(() => scan(request));
    },
    *waitForChange(request): Operation<void> {
      parseCounter(request.afterRevision, "wait revision");
      // The caller rechecks authority after the wait; no timer-driven payload clones.
      yield* sleep(Math.max(0, request.timeoutMs));
    },
    *apply(mutation): Operation<DurableMutationOutcome> {
      return yield* call(() => apply(mutation));
    },
  };
}
