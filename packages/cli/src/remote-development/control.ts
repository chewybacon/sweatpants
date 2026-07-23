import { canonicalJson, sha256, sha256Bytes } from "@sweatpants/session-contract";

import { validateCollectionProgramEntries } from "./evaluator-loader.ts";
import { decodeDevelopmentCollectionArchive } from "./collection.ts";
import {
  ACTIVE_COLLECTION_FORMAT,
  PUBLISHED_COLLECTION_FORMAT,
  RemoteDevelopmentError,
  type ActiveCollectionRecordV1,
  type DevelopmentCollectionManifestV1,
  type DevelopmentEnvironmentIdentityV1,
  type PublishedCollectionRefV1,
} from "./types.ts";

export interface PutVersionedObjectRequest {
  readonly bucket: string;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface VersionedObject {
  readonly versionId: string;
  readonly bytes: Uint8Array;
}

export interface VersionedObjectStore {
  put(request: PutVersionedObjectRequest): Promise<{ readonly versionId: string }>;
  get(bucket: string, key: string, versionId: string): Promise<VersionedObject>;
}

export interface PublishCollectionInput {
  readonly store: VersionedObjectStore;
  readonly bucket: string;
  readonly key: string;
  readonly archiveBytes: Uint8Array;
  readonly manifest: DevelopmentCollectionManifestV1;
  readonly now?: () => Date;
  readonly expiresAt?: Date;
}

export async function publishDevelopmentCollection(
  input: PublishCollectionInput,
): Promise<PublishedCollectionRefV1> {
  requireText(input.bucket, "bucket");
  requireText(input.key, "key");
  const objectDigest = sha256Bytes(input.archiveBytes);
  const result = await input.store.put({
    bucket: input.bucket,
    key: input.key,
    bytes: input.archiveBytes,
    metadata: Object.freeze({
      "sweatpants-object-digest": objectDigest,
      "sweatpants-collection-digest": input.manifest.collectionDigest,
    }),
  });
  if (!result.versionId) {
    throw new RemoteDevelopmentError(
      "object_digest_mismatch",
      "Versioned publication returned no object version",
    );
  }
  const restored = await input.store.get(input.bucket, input.key, result.versionId);
  if (restored.versionId !== result.versionId || sha256Bytes(restored.bytes) !== objectDigest) {
    throw new RemoteDevelopmentError(
      "object_digest_mismatch",
      "Published object failed exact-version verification",
    );
  }
  decodeDevelopmentCollectionArchive(restored.bytes, objectDigest);
  const now = input.now?.() ?? new Date();
  return Object.freeze({
    format: PUBLISHED_COLLECTION_FORMAT,
    bucket: input.bucket,
    key: input.key,
    versionId: result.versionId,
    objectDigest,
    collectionDigest: input.manifest.collectionDigest,
    bytes: input.archiveBytes.byteLength,
    publishedAt: now.toISOString(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt.toISOString() }),
  });
}

export interface CollectionReadinessEvidenceV1 {
  readonly collection: PublishedCollectionRefV1;
  readonly evaluatorReleaseId: string;
  readonly evaluatorAbi: string;
  readonly readinessDigest: string;
}

export async function verifyCollectionReadiness(input: {
  readonly store: VersionedObjectStore;
  readonly collection: PublishedCollectionRefV1;
  readonly evaluatorReleaseId: string;
  readonly evaluatorAbi: string;
}): Promise<CollectionReadinessEvidenceV1> {
  validatePublishedCollectionRef(input.collection);
  requireText(input.evaluatorReleaseId, "evaluator release");
  requireText(input.evaluatorAbi, "evaluator ABI");
  const object = await input.store.get(
    input.collection.bucket,
    input.collection.key,
    input.collection.versionId,
  );
  if (
    object.versionId !== input.collection.versionId ||
    object.bytes.byteLength !== input.collection.bytes
  ) {
    throw new RemoteDevelopmentError(
      "object_digest_mismatch",
      "Readiness fetched a different object version or size",
    );
  }
  const built = decodeDevelopmentCollectionArchive(object.bytes, input.collection.objectDigest);
  if (built.manifest.collectionDigest !== input.collection.collectionDigest) {
    throw new RemoteDevelopmentError(
      "collection_digest_mismatch",
      "Readiness collection digest differs",
    );
  }
  if (built.manifest.evaluatorAbi !== input.evaluatorAbi) {
    throw new RemoteDevelopmentError("evaluator_abi_mismatch", "Collection evaluator ABI differs");
  }
  await validateCollectionProgramEntries(built.manifest, built.files);
  const readinessDigest = sha256(
    `sweatpants.collection-readiness.v1\n${canonicalJson({
      collection: input.collection,
      evaluatorReleaseId: input.evaluatorReleaseId,
      evaluatorAbi: input.evaluatorAbi,
    })}`,
  );
  return Object.freeze({
    collection: input.collection,
    evaluatorReleaseId: input.evaluatorReleaseId,
    evaluatorAbi: input.evaluatorAbi,
    readinessDigest,
  });
}

export interface ActiveCollectionSnapshot {
  readonly revision?: string;
  readonly record?: ActiveCollectionRecordV1;
}

export interface ActiveCollectionStore {
  read(environment: DevelopmentEnvironmentIdentityV1): Promise<ActiveCollectionSnapshot>;
  compareAndSwap(
    environment: DevelopmentEnvironmentIdentityV1,
    expectedRevision: string | undefined,
    record: ActiveCollectionRecordV1,
  ): Promise<
    { readonly status: "written"; readonly revision: string } | { readonly status: "conflict" }
  >;
}

export async function activateReadyCollection(input: {
  readonly store: ActiveCollectionStore;
  readonly environment: DevelopmentEnvironmentIdentityV1;
  readonly writerId: string;
  readonly expected: ActiveCollectionSnapshot;
  readonly readiness: CollectionReadinessEvidenceV1;
  readonly now?: () => Date;
}): Promise<{ readonly record: ActiveCollectionRecordV1; readonly revision: string }> {
  requireText(input.writerId, "writer ID");
  const current = input.expected.record;
  const record: ActiveCollectionRecordV1 = Object.freeze({
    format: ACTIVE_COLLECTION_FORMAT,
    environment: input.environment,
    epoch: (current?.epoch ?? 0) + 1,
    writerId: input.writerId,
    collection: input.readiness.collection,
    evaluatorReleaseId: input.readiness.evaluatorReleaseId,
    evaluatorAbi: input.readiness.evaluatorAbi,
    readinessDigest: input.readiness.readinessDigest,
    activatedAt: (input.now?.() ?? new Date()).toISOString(),
    ...(current === undefined
      ? {}
      : { previousCollectionDigest: current.collection.collectionDigest }),
  });
  const result = await input.store.compareAndSwap(
    input.environment,
    input.expected.revision,
    record,
  );
  if (result.status === "conflict") {
    throw new RemoteDevelopmentError(
      "activation_authority_lost",
      "Active collection changed before activation",
    );
  }
  return { record, revision: result.revision };
}

export async function assertActivationAuthority(input: {
  readonly store: ActiveCollectionStore;
  readonly environment: DevelopmentEnvironmentIdentityV1;
  readonly writerId: string;
  readonly epoch: number;
}): Promise<void> {
  const current = (await input.store.read(input.environment)).record;
  if (!current || current.writerId !== input.writerId || current.epoch !== input.epoch) {
    throw new RemoteDevelopmentError(
      "activation_authority_lost",
      "Remote-development writer no longer owns activation authority",
    );
  }
}

export class InMemoryVersionedObjectStore implements VersionedObjectStore {
  readonly #objects = new Map<string, Uint8Array[]>();

  async put(request: PutVersionedObjectRequest): Promise<{ readonly versionId: string }> {
    const id = `${request.bucket}\n${request.key}`;
    const versions = this.#objects.get(id) ?? [];
    versions.push(Uint8Array.from(request.bytes));
    this.#objects.set(id, versions);
    return { versionId: String(versions.length) };
  }

  async get(bucket: string, key: string, versionId: string): Promise<VersionedObject> {
    const index = Number(versionId) - 1;
    const bytes = this.#objects.get(`${bucket}\n${key}`)?.[index];
    if (!bytes) {
      throw new RemoteDevelopmentError(
        "release_expired",
        "Exact collection object version is unavailable",
      );
    }
    return { versionId, bytes: Uint8Array.from(bytes) };
  }
}

export class InMemoryActiveCollectionStore implements ActiveCollectionStore {
  readonly #records = new Map<string, { revision: number; record: ActiveCollectionRecordV1 }>();

  async read(environment: DevelopmentEnvironmentIdentityV1): Promise<ActiveCollectionSnapshot> {
    const current = this.#records.get(environmentSlug(environment));
    return current ? { revision: String(current.revision), record: current.record } : {};
  }

  async compareAndSwap(
    environment: DevelopmentEnvironmentIdentityV1,
    expectedRevision: string | undefined,
    record: ActiveCollectionRecordV1,
  ): Promise<
    { readonly status: "written"; readonly revision: string } | { readonly status: "conflict" }
  > {
    const key = environmentSlug(environment);
    const current = this.#records.get(key);
    if (expectedRevision !== (current ? String(current.revision) : undefined)) {
      return { status: "conflict" };
    }
    const revision = (current?.revision ?? 0) + 1;
    this.#records.set(key, { revision, record });
    return { status: "written", revision: String(revision) };
  }
}

export function environmentSlug(identity: DevelopmentEnvironmentIdentityV1): string {
  for (const [field, value] of Object.entries(identity)) {
    requireText(value, field);
  }
  const readable = [identity.project, identity.owner, identity.name]
    .map(
      (part) =>
        part
          .toLowerCase()
          .replace(/[^a-z0-9-]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, 20) || "x",
    )
    .join("-");
  return `${readable}-${sha256(canonicalJson(identity)).slice(0, 16)}`.slice(0, 80);
}

export function environmentTags(
  identity: DevelopmentEnvironmentIdentityV1,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "sweatpants:format": "1",
    "sweatpants:purpose": "remote-development",
    "sweatpants:project": identity.project,
    "sweatpants:owner": identity.owner,
    "sweatpants:environment": identity.name,
    "sweatpants:managed": "true",
  });
}

export function validatePublishedCollectionRef(value: PublishedCollectionRefV1): void {
  if (
    value.format !== PUBLISHED_COLLECTION_FORMAT ||
    !value.bucket ||
    !value.key ||
    !value.versionId ||
    !/^[0-9a-f]{64}$/u.test(value.objectDigest) ||
    !/^[0-9a-f]{64}$/u.test(value.collectionDigest) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !isUtc(value.publishedAt) ||
    (value.expiresAt !== undefined && !isUtc(value.expiresAt))
  ) {
    throw new RemoteDevelopmentError(
      "invalid_collection_manifest",
      "Published collection reference is incomplete or mutable",
    );
  }
}

function isUtc(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new RemoteDevelopmentError(
      "invalid_remote_config",
      `${field} must be a bounded non-empty string`,
    );
  }
}
