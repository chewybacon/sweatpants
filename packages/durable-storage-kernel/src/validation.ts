import { decodeDurableKey, DurableMutationInvalid } from "./codec.ts";
import {
  DURABLE_MUTATION_MAX_BYTES,
  DURABLE_MUTATION_MAX_ENSURES,
  DURABLE_SCAN_MAX_BYTES,
  DURABLE_SCAN_MAX_RECORDS,
  type BoundedScan,
  type DurableMutation,
  type StoredAuthorityRecord,
} from "./contract.ts";
import { isAuthorityCollection, isImmutableCollection } from "./collections.ts";

export function parseCounter(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new DurableMutationInvalid(`${field} must be a canonical non-negative decimal counter`);
  }
  return BigInt(value);
}

function validateName(name: string, names: Set<string>): void {
  if (name.length === 0 || name.length > 128) {
    throw new DurableMutationInvalid("Mutation component names must contain 1 to 128 characters");
  }
  if (names.has(name)) {
    throw new DurableMutationInvalid(`Duplicate mutation component name ${name}`);
  }
  names.add(name);
}

function validateFingerprint(value: string, field: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new DurableMutationInvalid(`${field} must contain 1 to 512 characters`);
  }
}

function encodedTextBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateMutationStructure(mutation: DurableMutation): void {
  if (mutation.ensures.length > DURABLE_MUTATION_MAX_ENSURES) {
    throw new DurableMutationInvalid(
      `Mutation has ${mutation.ensures.length} ensures; maximum is ${DURABLE_MUTATION_MAX_ENSURES}`,
    );
  }
  const names = new Set<string>();
  const identities = new Set<string>();
  let bytes = 0;

  if (mutation.claim) {
    validateName(mutation.claim.name, names);
    if (!isImmutableCollection(mutation.claim.collection)) {
      throw new DurableMutationInvalid(`Unknown immutable collection ${mutation.claim.collection}`);
    }
    decodeDurableKey(mutation.claim.key);
    validateFingerprint(mutation.claim.fingerprint, "claim fingerprint");
    bytes +=
      mutation.claim.value.byteLength +
      encodedTextBytes(mutation.claim.name) +
      encodedTextBytes(mutation.claim.key) +
      encodedTextBytes(mutation.claim.fingerprint);
    identities.add(`${mutation.claim.collection}\u0000${mutation.claim.key}`);
  }

  for (const ensure of mutation.ensures) {
    validateName(ensure.name, names);
    if (!isImmutableCollection(ensure.collection)) {
      throw new DurableMutationInvalid(`Unknown immutable collection ${ensure.collection}`);
    }
    validateFingerprint(ensure.fingerprint, `ensure ${ensure.name} fingerprint`);
    const keys = [ensure.key, ...(ensure.alternateKeys ?? [])];
    if (new Set(keys).size !== keys.length) {
      throw new DurableMutationInvalid(`Ensure ${ensure.name} contains duplicate identities`);
    }
    for (const key of keys) {
      decodeDurableKey(key);
      const identity = `${ensure.collection}\u0000${key}`;
      if (identities.has(identity)) {
        throw new DurableMutationInvalid(`Mutation repeats immutable identity ${key}`);
      }
      identities.add(identity);
    }
    bytes +=
      ensure.value.byteLength +
      encodedTextBytes(ensure.name) +
      encodedTextBytes(ensure.fingerprint) +
      keys.reduce((total, key) => total + encodedTextBytes(key), 0);
  }

  if (mutation.authority) {
    validateName(mutation.authority.name, names);
    if (!isAuthorityCollection(mutation.authority.collection)) {
      throw new DurableMutationInvalid(`Unknown authority collection ${mutation.authority.collection}`);
    }
    decodeDurableKey(mutation.authority.key);
    parseCounter(mutation.authority.next.revision, "next revision");
    if (mutation.authority.expected.revision !== null) {
      parseCounter(mutation.authority.expected.revision, "expected revision");
    }
    if (mutation.authority.expected.fence !== undefined && mutation.authority.expected.fence !== null) {
      parseCounter(mutation.authority.expected.fence, "expected fence");
    }
    if (mutation.authority.next.fence !== undefined && mutation.authority.next.fence !== null) {
      parseCounter(mutation.authority.next.fence, "next fence");
    }
    bytes +=
      mutation.authority.next.value.byteLength +
      encodedTextBytes(mutation.authority.name) +
      encodedTextBytes(mutation.authority.key) +
      encodedTextBytes(mutation.authority.next.revision) +
      encodedTextBytes(mutation.authority.next.fence ?? "") +
      encodedTextBytes(mutation.authority.expected.revision ?? "") +
      encodedTextBytes(mutation.authority.expected.fence ?? "");
  }

  if (!mutation.claim && mutation.ensures.length === 0 && !mutation.authority) {
    throw new DurableMutationInvalid("Mutation must contain a claim, ensure, or authority replacement");
  }
  if (bytes > DURABLE_MUTATION_MAX_BYTES) {
    throw new DurableMutationInvalid(
      `Mutation body is ${bytes} bytes; maximum is ${DURABLE_MUTATION_MAX_BYTES}`,
    );
  }
}

export function authorityMismatch(
  replacement: NonNullable<DurableMutation["authority"]>,
  current: StoredAuthorityRecord | null,
): "fence" | "revision" | null {
  const expectedFence = replacement.expected.fence;
  if (current === null) {
    if (expectedFence !== undefined && expectedFence !== null && expectedFence !== "0") {
      return "fence";
    }
    if (replacement.expected.revision !== null) {
      return "revision";
    }
    if (replacement.next.revision !== "0") {
      throw new DurableMutationInvalid("Initial authority revision must be 0");
    }
    return null;
  }
  if (expectedFence !== undefined && current.fence !== expectedFence) {
    return "fence";
  }
  if (current.revision !== replacement.expected.revision) {
    return "revision";
  }
  const nextRevision = parseCounter(replacement.next.revision, "next revision");
  if (nextRevision !== parseCounter(current.revision, "current revision") + 1n) {
    throw new DurableMutationInvalid("Next authority revision must increment current revision by one");
  }
  const nextFence = replacement.next.fence;
  if (nextFence !== undefined && nextFence !== null && current.fence !== null) {
    if (parseCounter(nextFence, "next fence") < parseCounter(current.fence, "current fence")) {
      throw new DurableMutationInvalid("Next authority fence cannot decrease");
    }
  }
  return null;
}

export function validateScan(request: BoundedScan): void {
  decodeDurableKey(request.scope);
  if (
    !Number.isSafeInteger(request.maxRecords) ||
    request.maxRecords <= 0 ||
    request.maxRecords > DURABLE_SCAN_MAX_RECORDS
  ) {
    throw new DurableMutationInvalid(`Invalid scan record bound ${request.maxRecords}`);
  }
  if (
    !Number.isSafeInteger(request.maxStoredBytes) ||
    request.maxStoredBytes <= 0 ||
    request.maxStoredBytes > DURABLE_SCAN_MAX_BYTES
  ) {
    throw new DurableMutationInvalid(`Invalid scan byte bound ${request.maxStoredBytes}`);
  }
  if (request.after !== null) {
    parseCounter(request.after, "scan cursor");
  }
  if (request.through !== undefined) {
    parseCounter(request.through, "scan frontier");
  }
}
