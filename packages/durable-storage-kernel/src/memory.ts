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
import { decodeDurableKey } from "./codec.ts";
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

    if (mutation.claim) {
      const record: StoredImmutableRecord = {
        collection: mutation.claim.collection,
        key: mutation.claim.key,
        fingerprint: mutation.claim.fingerprint,
        value: cloneBytes(mutation.claim.value),
      };
      const entry = { record, aliases: [mutation.claim.key] };
      immutableAliases.set(identity(record.collection, record.key), entry);
    }

    for (const ensure of mutation.ensures) {
      if (resolved.has(ensure.name)) {
        continue;
      }
      const record: StoredImmutableRecord = {
        collection: ensure.collection,
        key: ensure.key,
        fingerprint: ensure.fingerprint,
        value: cloneBytes(ensure.value),
      };
      const aliases = [ensure.key, ...(ensure.alternateKeys ?? [])];
      const entry = { record, aliases };
      for (const key of aliases) {
        immutableAliases.set(identity(ensure.collection, key), entry);
      }
      resolved.set(ensure.name, cloneImmutable(record));
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
    const scope = decodeDurableKey(request.scope);
    const seen = new Set<ImmutableEntry>();
    const records: Array<{ record: StoredImmutableRecord; position: string }> = [];
    for (const entry of immutableAliases.values()) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      if (entry.record.collection !== request.collection) {
        continue;
      }
      const taskCollection = request.index === "task-sequence";
      const positionKey = entry.aliases
        .map((key) => decodeDurableKey(key))
        .find((key) => {
          const required = taskCollection
            ? 4
            : entry.record.collection === "conversation-public-root-index"
              ? 2
              : 3;
          return key.length >= required && scope.every((part, index) => key[index] === part);
        });
      if (!positionKey) {
        continue;
      }
      const position = positionKey[taskCollection ? 2 : 1]!;
      parseCounter(position, "stored scan position");
      records.push({ record: entry.record, position });
    }
    records.sort((left, right) => {
      const order =
        parseCounter(left.position, "scan position") -
        parseCounter(right.position, "scan position");
      if (order === 0n) {
        return left.record.key.localeCompare(right.record.key);
      }
      return order < 0n ? -1 : 1;
    });
    if (request.direction === "backward") {
      records.reverse();
    }

    const after = request.after === null ? null : parseCounter(request.after, "scan cursor");
    const through =
      request.through === undefined ? null : parseCounter(request.through, "scan frontier");
    const selected = [];
    let bytes = 0;
    let hasMore = false;
    for (const candidate of records) {
      const position = parseCounter(candidate.position, "scan position");
      if (after !== null) {
        if (request.direction === "forward" ? position <= after : position >= after) {
          continue;
        }
      }
      if (through !== null) {
        if (request.direction === "forward" ? position > through : position < through) {
          continue;
        }
      }
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
      const deadline = Date.now() + Math.max(0, request.timeoutMs);
      const after = parseCounter(request.afterRevision, "wait revision");
      while (Date.now() < deadline) {
        const current = readAuthority(request.collection, request.key);
        if (current && parseCounter(current.revision, "authority revision") > after) {
          return;
        }
        yield* sleep(Math.min(10, deadline - Date.now()));
      }
    },
    *apply(mutation): Operation<DurableMutationOutcome> {
      return yield* call(() => apply(mutation));
    },
  };
}
