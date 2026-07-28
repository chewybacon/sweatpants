import { CrankError } from "@sweatpants/durable-execution";
import { sha256Bytes } from "@sweatpants/session-contract";

export type A2AContentRetentionClass = "ephemeral" | "task" | "audit" | string;

/** Journal-owned metadata for immutable bytes. This contains no mutable task state. */
export interface A2AContentReference {
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
  readonly association: {
    readonly kind: "message" | "artifact";
    readonly id: string;
  };
  readonly retentionClass: A2AContentRetentionClass;
}

export interface ImmutableContentObject {
  readonly digest: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
  readonly retainUntil?: number;
}

export type ContentRetrievalResult =
  | { readonly status: "available"; readonly object: ImmutableContentObject }
  | { readonly status: "content_unavailable"; readonly digest: string }
  | { readonly status: "content_expired"; readonly digest: string; readonly expiredAt: number };

/** Digest-addressed byte custody only; task state and authorization never belong here. */
export interface ImmutableContentStore {
  put(input: {
    readonly digest: string;
    readonly bytes: Uint8Array;
    readonly retainUntil?: number;
  }): Promise<ImmutableContentObject>;
  get(digest: string, now?: number): Promise<ContentRetrievalResult>;
  deleteOrphans(input: {
    readonly referencedDigests: ReadonlySet<string>;
    readonly createdBefore: number;
  }): Promise<readonly string[]>;
  check?(): Promise<void>;
}

export class ContentStoreError extends CrankError {
  readonly _contentStoreTag = "ContentStoreError";
}

/** Reference adapter with the same immutable semantics required of persistent stores. */
export function createInMemoryImmutableContentStore(
  now: () => number = Date.now,
): ImmutableContentStore {
  const objects = new Map<string, ImmutableContentObject>();
  return {
    async put(input) {
      assertDigest(input.digest);
      const bytes = new Uint8Array(input.bytes);
      const actual = sha256Bytes(bytes);
      if (actual !== input.digest) {
        throw new ContentStoreError(
          "content_digest_conflict",
          "Content bytes do not match their declared digest",
        );
      }
      const previous = objects.get(input.digest);
      if (previous) {
        if (previous.size !== bytes.byteLength || !equalBytes(previous.bytes, bytes)) {
          throw new ContentStoreError(
            "content_digest_conflict",
            "A digest is already bound to different content",
          );
        }
        if (
          input.retainUntil !== undefined &&
          (previous.retainUntil === undefined || input.retainUntil > previous.retainUntil)
        ) {
          const extended = freezeObject({ ...previous, retainUntil: input.retainUntil });
          objects.set(input.digest, extended);
          return cloneObject(extended);
        }
        return cloneObject(previous);
      }
      const stored = freezeObject({
        digest: input.digest,
        size: bytes.byteLength,
        bytes,
        createdAt: now(),
        ...(input.retainUntil !== undefined ? { retainUntil: input.retainUntil } : {}),
      });
      objects.set(input.digest, stored);
      return cloneObject(stored);
    },
    async get(digest, at = now()) {
      assertDigest(digest);
      const object = objects.get(digest);
      if (!object) {
        return { status: "content_unavailable", digest };
      }
      if (object.retainUntil !== undefined && at >= object.retainUntil) {
        return { status: "content_expired", digest, expiredAt: object.retainUntil };
      }
      if (sha256Bytes(object.bytes) !== digest || object.bytes.byteLength !== object.size) {
        return { status: "content_unavailable", digest };
      }
      return { status: "available", object: cloneObject(object) };
    },
    async deleteOrphans(input) {
      const deleted: string[] = [];
      for (const [digest, object] of objects) {
        if (
          !input.referencedDigests.has(digest) &&
          object.createdAt < input.createdBefore &&
          (object.retainUntil === undefined || object.retainUntil <= input.createdBefore)
        ) {
          objects.delete(digest);
          deleted.push(digest);
        }
      }
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 package target has no toSorted.
      return Object.freeze(deleted.sort());
    },
    async check() {},
  };
}

/**
 * Performs the mandatory write-then-verify sequence. Callers may commit the returned
 * reference to their journal only after this function succeeds.
 */
export async function putVerifiedContent(
  store: ImmutableContentStore,
  input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly association: A2AContentReference["association"];
    readonly retentionClass: A2AContentRetentionClass;
    readonly retainUntil?: number;
  },
): Promise<A2AContentReference> {
  if (!input.mediaType || input.mediaType.length > 512) {
    throw new ContentStoreError("invalid_descriptor", "Content media type is invalid");
  }
  if (!input.association.id || input.association.id.length > 512) {
    throw new ContentStoreError("invalid_descriptor", "Content association is invalid");
  }
  const bytes = new Uint8Array(input.bytes);
  const digest = sha256Bytes(bytes);
  const stored = await store.put({
    digest,
    bytes,
    ...(input.retainUntil !== undefined ? { retainUntil: input.retainUntil } : {}),
  });
  const verified = await store.get(digest);
  if (
    verified.status !== "available" ||
    stored.size !== bytes.byteLength ||
    verified.object.size !== bytes.byteLength ||
    sha256Bytes(verified.object.bytes) !== digest
  ) {
    throw new ContentStoreError(
      "content_unavailable",
      "Content could not be verified before journal reference commit",
    );
  }
  return Object.freeze({
    digest,
    size: bytes.byteLength,
    mediaType: input.mediaType,
    association: Object.freeze({ ...input.association }),
    retentionClass: input.retentionClass,
  });
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ContentStoreError("invalid_descriptor", "Content digest is invalid");
  }
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
function freezeObject(value: ImmutableContentObject): ImmutableContentObject {
  // The byte array is never returned directly; cloneObject preserves custody.
  return Object.freeze(value);
}
function cloneObject(value: ImmutableContentObject): ImmutableContentObject {
  return Object.freeze({ ...value, bytes: new Uint8Array(value.bytes) });
}
