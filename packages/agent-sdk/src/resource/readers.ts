import { fromByteArray } from "base64-js";
import { assertJson, canonicalJson, sha256, sha256Bytes, type Json } from "@sweatpants/foundation";
import {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  generateProgramArtifactIdentity,
  type DurableProgramManifest,
  type PinnedProgram,
} from "@sweatpants/durable-execution";

import { formatResourceUri, normalizeResourcePath, parseResourceUri } from "./package.ts";
import { readerSchemaArtifacts } from "./reader-schemas.ts";
import {
  accessAllowed,
  combineResourceProvenance,
  resolveAuthorizedResource,
  type ResourceLookupOptions,
  type ResourcePackageRegistry,
} from "./registry.ts";
import {
  RESOURCE_SEARCH_EXCERPT_CODE_UNITS,
  RESOURCE_SEARCH_MATCH_SEMANTICS,
  RESOURCE_SEARCH_MAX_QUERY_BYTES,
  ResourceError,
  sortedResourceValues,
  type DataClassification,
  type ResourceConsumer,
  type ResourceFileRefV1,
  type ResourceListEntry,
  type ResourceListResult,
  type ResourceReadResult,
  type ResourceReaderProgram,
  type ResourceReaderPrograms,
  type ResourceStatResult,
  type ReaderOperation,
  type ResourceValueProvenance,
  type ResourceView,
} from "./types.ts";

export const RESOURCE_READER_ENGINE: PinnedProgram = Object.freeze({
  id: "sweatpants.resource-reader",
  version: "1",
  digest: sha256("sweatpants.resource-reader.engine.v1"),
});

export interface GenerateResourceReadersOptions {
  readonly view: ResourceView;
  readonly registry: ResourcePackageRegistry;
  readonly consumer: ResourceConsumer;
  readonly engine?: PinnedProgram;
  /** Use at external reader boundaries to avoid package/file existence disclosure. */
  readonly hideExistence?: boolean;
}

/** Generates effect-free deterministic native children pinned to one exact view and consumer. */
export function generateResourceReaders(
  options: GenerateResourceReadersOptions,
): ResourceReaderPrograms {
  const engine = options.engine ?? RESOURCE_READER_ENGINE;
  requireProgram(engine);
  const stat = createReader("stat", options, engine);
  const list = createReader("list", options, engine);
  const read = createReader("read", options, engine);
  const search = createReader("search", options, engine);
  return Object.freeze({ stat, list, read, search, provenance: stat.identityProvenance });
}

/** Executes deterministic stat semantics directly; generated children call this same implementation. */
export function statResource(
  view: ResourceView,
  registry: ResourcePackageRegistry,
  consumer: ResourceConsumer,
  ref: ResourceFileRefV1,
  lookupOptions: ResourceLookupOptions = {},
): ResourceStatResult {
  const resolved = resolveAuthorizedResource(view, registry, ref, consumer, lookupOptions);
  const provenance = provenanceFor(
    resolved.file.digest,
    resolved.package.manifest.digest,
    resolved.classification,
  );
  return deepFreeze({
    ref: resolved.ref,
    uri: formatResourceUri(resolved.ref),
    mediaType: resolved.file.mediaType,
    size: resolved.file.size,
    fileDigest: resolved.file.digest,
    ...provenance,
  });
}

/** Executes deterministic bounded listing over authorized logical mounts. */
export function listResources(
  view: ResourceView,
  registry: ResourcePackageRegistry,
  consumer: ResourceConsumer,
  input: { readonly prefix?: string; readonly cursor?: string } = {},
): ResourceListResult {
  const prefix =
    input.prefix === undefined || input.prefix === ""
      ? ""
      : normalizeResourcePath(input.prefix, view.limits);
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" || input.cursor.length === 0)
  ) {
    throw new ResourceError("invalid_resource_path", "Invalid resource list cursor");
  }
  const entries: ResourceListEntry[] = [];
  for (const mount of view.mounts) {
    if (!accessAllowed(mount.access, consumer)) {
      continue;
    }
    const pkg = registry.resolve(mount.package.manifest.digest, {
      id: mount.package.manifest.id,
      version: mount.package.manifest.version,
    });
    for (const path of Object.keys(pkg.manifest.files)) {
      const logicalPath = `${mount.root}/${path}`;
      if (prefix && logicalPath !== prefix && !logicalPath.startsWith(`${prefix}/`)) {
        continue;
      }
      if (input.cursor !== undefined && logicalPath <= input.cursor) {
        continue;
      }
      const file = pkg.manifest.files[path]!;
      const ref = Object.freeze({
        packageId: pkg.manifest.id,
        packageDigest: pkg.manifest.digest,
        path,
      });
      entries.push(
        Object.freeze({
          logicalPath,
          ref,
          uri: formatResourceUri(ref),
          mediaType: file.mediaType,
          size: file.size,
          fileDigest: file.digest,
          ...(mount.access.kind === "model_readable"
            ? { classification: mount.access.classification }
            : {}),
        }),
      );
    }
  }
  entries.sort((left, right) => compareText(left.logicalPath, right.logicalPath));
  const truncated = entries.length > view.limits.maxListEntries;
  const page = entries.slice(0, view.limits.maxListEntries);
  const values = page.map((entry) =>
    provenanceFor(entry.fileDigest, entry.ref.packageDigest, entry.classification),
  );
  return deepFreeze({
    entries: page,
    truncated,
    ...(truncated && page.length > 0 ? { cursor: page[page.length - 1]!.logicalPath } : {}),
    ...combineResourceProvenance(values),
  });
}

/** Executes an exact bounded read with consumer-appropriate projection. */
export function readResource(
  view: ResourceView,
  registry: ResourcePackageRegistry,
  consumer: ResourceConsumer,
  ref: ResourceFileRefV1,
  lookupOptions: ResourceLookupOptions = {},
): ResourceReadResult {
  const resolved = resolveAuthorizedResource(view, registry, ref, consumer, lookupOptions);
  if (resolved.file.size > view.limits.maxReadBytes) {
    throw new ResourceError("resource_read_too_large", "Resource read exceeds configured limit");
  }
  const bytes = resolved.package.bindings.read(resolved.ref.path);
  if (!bytes) {
    throw new ResourceError("resource_not_found", "Resource file not found");
  }
  if (bytes.byteLength !== resolved.file.size || sha256Bytes(bytes) !== resolved.file.digest) {
    throw new ResourceError("resource_digest_mismatch", "Resource binding digest mismatch");
  }
  const provenance = provenanceFor(
    resolved.file.digest,
    resolved.package.manifest.digest,
    resolved.classification,
  );
  const base = {
    mediaType: resolved.file.mediaType,
    packageDigest: resolved.package.manifest.digest,
    fileDigest: resolved.file.digest,
    ...provenance,
  };
  if (resolved.file.mediaType.toLowerCase() === "application/json") {
    let value: Json;
    try {
      value = assertJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      throw new ResourceError("resource_digest_mismatch", "Stored JSON resource is invalid");
    }
    return deepFreeze({ ...base, kind: "json", mediaType: "application/json", value });
  }
  if (resolved.file.mediaType.toLowerCase().startsWith("text/")) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ResourceError("unsupported_resource_projection", "Resource is not valid text");
    }
    return deepFreeze({ ...base, kind: "text", text });
  }
  if (consumer.kind === "model") {
    throw new ResourceError(
      "unsupported_resource_projection",
      "Binary resource has no model-readable projection",
    );
  }
  return deepFreeze({ ...base, kind: "bytes", bytesBase64: fromByteArray(bytes) });
}

/**
 * Deterministic bounded text search. V1 reports at most the first match in each
 * authorized file, ordered by logical path. Scanning uses the same exact,
 * digest-checked, maxReadBytes-bounded projection as resources.read.
 */
export function searchResources(
  view: ResourceView,
  registry: ResourcePackageRegistry,
  consumer: ResourceConsumer,
  queryValue: string,
  lookupOptions: ResourceLookupOptions = {},
): Json {
  if (consumer.kind !== "model") {
    throw new ResourceError("resource_access_denied", "Resource search is model-scoped");
  }
  if (typeof queryValue !== "string" || queryValue.trim().length === 0) {
    throw new ResourceError("invalid_resource_manifest", "Invalid resource search query");
  }
  const normalizedQuery = queryValue.trim().normalize("NFC").toLocaleLowerCase("und");
  if (new TextEncoder().encode(normalizedQuery).byteLength > RESOURCE_SEARCH_MAX_QUERY_BYTES) {
    throw new ResourceError("resource_limit_exceeded", "Resource search query exceeds limit");
  }
  const candidates = sortedResourceValues(
    view.mounts.flatMap((mount) => {
      if (mount.access.kind !== "model_readable") {
        return [];
      }
      const classification = mount.access.classification;
      return Object.entries(mount.package.manifest.files)
        .filter(([, file]) => file.mediaType.toLowerCase().startsWith("text/"))
        .map(([path, file]) => ({
          logicalPath: `${mount.root}/${path}`,
          size: file.size,
          ref: {
            packageId: mount.package.manifest.id,
            packageDigest: mount.package.manifest.digest,
            path,
          },
          classification,
        }));
    }),
    (left, right) => compareText(left.logicalPath, right.logicalPath),
  );
  const matches: Array<{
    path: string;
    uri: string;
    excerpt: string;
    packageDigest: string;
    fileDigest: string;
    classification: DataClassification;
  }> = [];
  let truncated = false;
  let scannedBytes = 0;
  const maxScanBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    view.limits.maxReadBytes * view.limits.maxSearchMatches,
  );
  for (const candidate of candidates) {
    if (scannedBytes + candidate.size > maxScanBytes) {
      truncated = true;
      break;
    }
    const projection = readResource(view, registry, consumer, candidate.ref, lookupOptions);
    scannedBytes += candidate.size;
    if (projection.kind !== "text") {
      continue;
    }
    const normalizedText = projection.text.normalize("NFC").toLocaleLowerCase("und");
    const position = normalizedText.indexOf(normalizedQuery);
    if (position < 0) {
      continue;
    }
    if (matches.length === view.limits.maxSearchMatches) {
      truncated = true;
      break;
    }
    matches.push({
      path: candidate.logicalPath,
      uri: formatResourceUri(candidate.ref),
      excerpt: boundedExcerpt(projection.text, position, normalizedQuery.length),
      packageDigest: projection.packageDigest,
      fileDigest: projection.fileDigest,
      classification: candidate.classification,
    });
  }
  return assertJson({
    matchSemantics: RESOURCE_SEARCH_MATCH_SEMANTICS,
    matches,
    truncated,
    ...combineResourceProvenance(
      matches.map((match) =>
        provenanceFor(match.fileDigest, match.packageDigest, match.classification),
      ),
    ),
  });
}

function createReader(
  operation: ReaderOperation,
  options: GenerateResourceReadersOptions,
  engine: PinnedProgram,
): ResourceReaderProgram {
  const consumerDigest = sha256(canonicalJson(options.consumer));
  const schemas = readerSchemaArtifacts(operation);
  const lookupOptions: ResourceLookupOptions =
    options.hideExistence === undefined ? {} : { hideExistence: options.hideExistence };
  const manifestWithoutDigest: Omit<DurableProgramManifest, "digest"> = {
    programId: `resources.${operation}.${options.view.digest.slice(0, 16)}.${consumerDigest.slice(0, 12)}`,
    version: "1",
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    elicits: {},
    effects: {},
    capabilities: {
      durableEmissions: false,
      structuredChildren: false,
      replay: "strict",
    },
  };
  const implementationArtifactDigest = sha256(
    `sweatpants.resource-reader.binding.v1\n${canonicalJson({
      engine,
      operation,
      viewDigest: options.view.digest,
      consumer: options.consumer,
      limits: options.view.limits,
      hideExistence: options.hideExistence ?? false,
      searchMatchSemantics: RESOURCE_SEARCH_MATCH_SEMANTICS,
      inputSchema: schemas.input,
      outputSchema: schemas.output,
    })}`,
  );
  const artifact = generateProgramArtifactIdentity({
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
    manifest: manifestWithoutDigest,
    implementationArtifactDigest,
    resourcePackageDigests: sortedResourceValues(
      new Set(options.view.mounts.map((mount) => mount.package.manifest.digest)),
      compareText,
    ),
  });
  const program = createGeneratedPinnedDurableProgram(artifact, function* (input) {
    const record = requireRecord(input);
    if (operation === "stat") {
      return assertJson(
        statResource(
          options.view,
          options.registry,
          options.consumer,
          inputRef(record),
          lookupOptions,
        ),
      );
    }
    if (operation === "read") {
      return assertJson(
        readResource(
          options.view,
          options.registry,
          options.consumer,
          inputRef(record),
          lookupOptions,
        ),
      );
    }
    if (operation === "list") {
      return assertJson(
        listResources(options.view, options.registry, options.consumer, {
          ...(typeof record["prefix"] === "string" ? { prefix: record["prefix"] } : {}),
          ...(typeof record["cursor"] === "string" ? { cursor: record["cursor"] } : {}),
        }),
      );
    }
    if (typeof record["query"] !== "string") {
      throw new ResourceError("invalid_resource_manifest", "Invalid resource search input");
    }
    return searchResources(
      options.view,
      options.registry,
      options.consumer,
      record["query"],
      lookupOptions,
    );
  });
  // programId fragments are presentation-only. Registry and durable attachment
  // identity always use the full id@version#digest triple; the generated digest
  // above covers the complete view and consumer digests.
  return Object.freeze({ ...program, schemaCatalog: schemas.catalog });
}

function boundedExcerpt(text: string, position: number, queryLength: number): string {
  const desiredStart = Math.max(
    0,
    position - Math.floor((RESOURCE_SEARCH_EXCERPT_CODE_UNITS - Math.min(queryLength, 256)) / 2),
  );
  let start = desiredStart;
  let end = Math.min(text.length, start + RESOURCE_SEARCH_EXCERPT_CODE_UNITS);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function inputRef(input: Record<string, Json>): ResourceFileRefV1 {
  if (typeof input["uri"] === "string") {
    return parseResourceUri(input["uri"]);
  }
  const ref = input["ref"];
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    throw new ResourceError("invalid_resource_manifest", "Invalid resource reader input");
  }
  const record = ref as Record<string, Json>;
  if (
    typeof record["packageId"] !== "string" ||
    typeof record["packageDigest"] !== "string" ||
    typeof record["path"] !== "string"
  ) {
    throw new ResourceError("invalid_resource_manifest", "Invalid resource reader input");
  }
  return parseResourceUri(
    formatResourceUri({
      packageId: record["packageId"],
      packageDigest: record["packageDigest"],
      path: record["path"],
    }),
  );
}

function provenanceFor(
  fileDigest: string,
  packageDigest: string,
  classification?: DataClassification,
): ResourceValueProvenance {
  return deepFreeze({
    classifications: classification === undefined ? [] : [classification],
    sources: [{ packageDigest, fileDigest }],
  });
}

function requireRecord(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResourceError("invalid_resource_manifest", "Invalid resource reader input");
  }
  return value;
}

function requireProgram(value: PinnedProgram): void {
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.version !== "string" ||
    !value.version ||
    !/^[0-9a-f]{64}$/.test(value.digest)
  ) {
    throw new ResourceError("invalid_resource_manifest", "Invalid reader engine identity");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
