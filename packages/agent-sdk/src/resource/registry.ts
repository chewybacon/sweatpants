import { canonicalJson, canonicalSnapshot, sha256, stableTupleHash } from "@sweatpants/foundation";
import { type PinnedProgram } from "@sweatpants/durable-execution";

import {
  bindResourcePackage,
  formatResourceUri,
  normalizeResourcePath,
  parseResourceUri,
  resolveResourceLimits,
} from "./package.ts";
import {
  RESOURCE_VIEW_FORMAT,
  ResourceError,
  sortedResourceValues,
  type DataClassification,
  type GuidanceDefinition,
  type GuidanceIndexEntry,
  type ResourceConsumer,
  type ResourceFileRefV1,
  type ResourceLimits,
  type ResourceMount,
  type ResourceMountAccess,
  type ResourcePackage,
  type ResourceSourceProvenance,
  type ResourceValueProvenance,
  type ResourceView,
} from "./types.ts";

const CLASSIFICATIONS: readonly DataClassification[] = [
  "public",
  "internal",
  "confidential",
  "restricted",
];
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Exact immutable package registry with atomic complete installation. */
export class ResourcePackageRegistry {
  readonly #packages = new Map<string, ResourcePackage>();
  readonly #limits: ResourceLimits;

  constructor(limits?: Partial<ResourceLimits>) {
    this.#limits = resolveResourceLimits(limits);
  }

  install(candidate: ResourcePackage): ResourcePackage {
    // Rebinding copies bytes and validates complete coverage before visibility.
    const checked = bindResourcePackage(candidate.manifest, candidate.bindings, this.#limits);
    const existing = this.#packages.get(checked.manifest.digest);
    if (existing) {
      if (canonicalJson(existing.manifest) !== canonicalJson(checked.manifest)) {
        throw new ResourceError("resource_digest_mismatch", "Resource package digest collision");
      }
      return existing;
    }
    this.#packages.set(checked.manifest.digest, checked);
    return checked;
  }

  resolve(
    digest: string,
    expected?: { readonly id?: string; readonly version?: string },
  ): ResourcePackage {
    requireDigest(digest);
    const value = this.#packages.get(digest);
    if (!value) {
      throw new ResourceError("resource_not_found", "Resource package not found");
    }
    if (
      (expected?.id !== undefined && expected.id !== value.manifest.id) ||
      (expected?.version !== undefined && expected.version !== value.manifest.version)
    ) {
      throw new ResourceError("resource_identity_mismatch", "Resource package identity mismatch");
    }
    return value;
  }

  has(digest: string): boolean {
    return this.#packages.has(digest);
  }

  digests(): readonly string[] {
    return Object.freeze(sortedResourceValues(this.#packages.keys(), compareText));
  }
}

/** Creates a canonical order-independent, collision-free mounted resource view. */
export function defineResourceView(
  mountsValue: readonly ResourceMount[],
  options: { readonly limits?: Partial<ResourceLimits> } = {},
): ResourceView {
  if (!Array.isArray(mountsValue)) {
    invalidMount();
  }
  const limits = resolveResourceLimits(options.limits);
  const mounts = sortedResourceValues(
    mountsValue.map((mount) => normalizeMount(mount, limits)),
    (left, right) => compareText(left.root, right.root),
  );
  for (let index = 0; index < mounts.length; index += 1) {
    for (let other = index + 1; other < mounts.length; other += 1) {
      if (rootsOverlap(mounts[index]!.root, mounts[other]!.root)) {
        invalidMount();
      }
    }
  }
  const projection = {
    format: RESOURCE_VIEW_FORMAT,
    limits,
    mounts: mounts.map((mount) => ({
      root: mount.root,
      package: {
        id: mount.package.manifest.id,
        version: mount.package.manifest.version,
        digest: mount.package.manifest.digest,
      },
      access: mount.access,
    })),
  };
  return deepFreeze({
    ...projection,
    digest: sha256(`${RESOURCE_VIEW_FORMAT}\n${canonicalJson(projection)}`),
    mounts,
  });
}

/** Defines immutable advisory guidance over one exact text entry. */
export function defineGuidance(options: {
  readonly id: string;
  readonly summary: string;
  readonly package: ResourcePackage;
  readonly entryPath: string;
}): GuidanceDefinition {
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(options.id)) {
    throw new ResourceError("invalid_resource_manifest", "Invalid guidance definition");
  }
  if (
    typeof options.summary !== "string" ||
    options.summary.length === 0 ||
    new TextEncoder().encode(options.summary).byteLength > 1024
  ) {
    throw new ResourceError("invalid_resource_manifest", "Invalid guidance definition");
  }
  const entryPath = normalizeResourcePath(options.entryPath, options.package.limits);
  const entry = options.package.manifest.files[entryPath];
  if (!entry || !isTextMediaType(entry.mediaType)) {
    throw new ResourceError("resource_not_found", "Guidance entry is unavailable");
  }
  const entryUri = formatResourceUri({
    packageId: options.package.manifest.id,
    packageDigest: options.package.manifest.digest,
    path: entryPath,
  });
  return deepFreeze({
    id: options.id,
    summary: options.summary,
    package: options.package,
    entryPath,
    entryUri,
  });
}

/** Projects only bounded discovery metadata; package inventory and bytes remain opaque. */
export function guidanceIndex(
  guidance: readonly GuidanceDefinition[],
): readonly GuidanceIndexEntry[] {
  const ids = new Set<string>();
  return Object.freeze(
    sortedResourceValues(guidance, (left, right) => compareText(left.id, right.id)).map((item) => {
      if (ids.has(item.id)) {
        throw new ResourceError("invalid_resource_manifest", "Duplicate guidance identifier");
      }
      ids.add(item.id);
      return Object.freeze({ id: item.id, summary: item.summary, entryUri: item.entryUri });
    }),
  );
}

/** Produces a stable exact-payload classification and source union. */
export function combineResourceProvenance(
  values: readonly ResourceValueProvenance[],
): ResourceValueProvenance {
  const classifications = new Set<DataClassification>();
  const sources = new Map<string, ResourceSourceProvenance>();
  for (const value of values) {
    for (const classification of value.classifications) {
      if (!CLASSIFICATIONS.includes(classification)) {
        throw new ResourceError("invalid_resource_manifest", "Invalid data classification");
      }
      classifications.add(classification);
    }
    for (const source of value.sources) {
      requireDigest(source.packageDigest);
      requireDigest(source.fileDigest);
      sources.set(`${source.packageDigest}:${source.fileDigest}`, {
        packageDigest: source.packageDigest,
        fileDigest: source.fileDigest,
      });
    }
  }
  return deepFreeze({
    classifications: sortedResourceValues(classifications, compareText),
    sources: sortedResourceValues(sources.values(), (left, right) =>
      compareText(
        `${left.packageDigest}:${left.fileDigest}`,
        `${right.packageDigest}:${right.fileDigest}`,
      ),
    ),
  });
}

/** Resolves a guidance-relative or absolute exact reference without host/network fallback. */
export function resolveGuidanceLink(
  guidance: GuidanceDefinition,
  link: string,
  view: ResourceView,
  registry: ResourcePackageRegistry,
  consumer: ResourceConsumer,
): { readonly ref: ResourceFileRefV1; readonly fileDigest: string } {
  let ref: ResourceFileRefV1;
  if (link.startsWith("resource://")) {
    ref = parseResourceUri(link);
  } else {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || link.startsWith("/") || link.includes("\\")) {
      throw new ResourceError("invalid_resource_path", "Invalid resource link");
    }
    const base = guidance.entryPath.split("/").slice(0, -1);
    for (const segment of link.split("/")) {
      if (segment === "") {
        throw new ResourceError("invalid_resource_path", "Invalid resource link");
      }
      if (segment === ".") {
        continue;
      }
      if (segment === "..") {
        if (base.length === 0) {
          throw new ResourceError("invalid_resource_path", "Invalid resource link");
        }
        base.pop();
      } else {
        base.push(segment);
      }
    }
    ref = {
      packageId: guidance.package.manifest.id,
      packageDigest: guidance.package.manifest.digest,
      path: normalizeResourcePath(base.join("/"), guidance.package.limits),
    };
  }
  const resolved = resolveAuthorizedResource(view, registry, ref, consumer);
  return Object.freeze({ ref: resolved.ref, fileDigest: resolved.file.digest });
}

export interface AuthorizedResource {
  readonly ref: ResourceFileRefV1;
  readonly mount: ResourceMount;
  readonly package: ResourcePackage;
  readonly file: ResourcePackage["manifest"]["files"][string];
  readonly classification?: DataClassification;
}

export interface ResourceLookupOptions {
  /** Collapse missing, mismatched, and denied lookups at an external trust boundary. */
  readonly hideExistence?: boolean;
}

/** Resolves exact identity and scope, optionally collapsing existence-sensitive failures. */
export function resolveAuthorizedResource(
  view: ResourceView,
  registry: ResourcePackageRegistry,
  refValue: ResourceFileRefV1,
  consumer: ResourceConsumer,
  options: ResourceLookupOptions = {},
): AuthorizedResource {
  try {
    const ref = canonicalRef(refValue);
    const pkg = registry.resolve(ref.packageDigest, { id: ref.packageId });
    const candidates = view.mounts.filter(
      (mount) => mount.package.manifest.digest === ref.packageDigest,
    );
    const mount = candidates.find((candidate) => accessAllowed(candidate.access, consumer));
    if (!mount) {
      throw new ResourceError("resource_access_denied", "Resource access denied");
    }
    const file = pkg.manifest.files[ref.path];
    if (!file) {
      throw new ResourceError("resource_not_found", "Resource file not found");
    }
    return Object.freeze({
      ref,
      mount,
      package: pkg,
      file,
      ...(mount.access.kind === "model_readable"
        ? { classification: mount.access.classification }
        : {}),
    });
  } catch (error) {
    if (
      options.hideExistence &&
      error instanceof ResourceError &&
      ["resource_access_denied", "resource_not_found", "resource_identity_mismatch"].includes(
        error.code,
      )
    ) {
      throw new ResourceError("resource_not_found", "Resource unavailable");
    }
    throw error;
  }
}

export function accessAllowed(access: ResourceMountAccess, consumer: ResourceConsumer): boolean {
  if (access.kind === "program_private") {
    return consumer.kind === "program";
  }
  if (access.kind === "model_readable") {
    return consumer.kind === "model" || consumer.kind === "program";
  }
  if (consumer.kind !== "tool") {
    return false;
  }
  return access.tools.some((tool) => sameProgram(tool, consumer.program));
}

function normalizeMount(mount: ResourceMount, limits: ResourceLimits): ResourceMount {
  if (!mount || typeof mount !== "object" || !mount.package || !mount.access) {
    invalidMount();
  }
  const root = normalizeResourcePath(mount.root, limits);
  let access: ResourceMountAccess;
  if (mount.access.kind === "program_private") {
    if (Object.keys(mount.access).length !== 1) {
      invalidMount();
    }
    access = { kind: "program_private" };
  } else if (mount.access.kind === "model_readable") {
    if (
      Object.keys(mount.access).length !== 2 ||
      !CLASSIFICATIONS.includes(mount.access.classification)
    ) {
      invalidMount();
    }
    access = { kind: "model_readable", classification: mount.access.classification };
  } else if (mount.access.kind === "tool_scoped") {
    if (Object.keys(mount.access).length !== 2 || !Array.isArray(mount.access.tools)) {
      invalidMount();
    }
    const tools = sortedResourceValues(mount.access.tools.map(canonicalProgram), (left, right) =>
      compareText(programKey(left), programKey(right)),
    );
    for (let index = 1; index < tools.length; index += 1) {
      if (programKey(tools[index]!) === programKey(tools[index - 1]!)) {
        invalidMount();
      }
    }
    access = { kind: "tool_scoped", tools };
  } else {
    invalidMount();
  }
  return deepFreeze({ root, package: mount.package, access });
}

function canonicalRef(value: ResourceFileRefV1): ResourceFileRefV1 {
  // URI round-trip supplies all closed-shape and canonical checks.
  return parseResourceUri(formatResourceUri(value));
}

function canonicalProgram(value: PinnedProgram): PinnedProgram {
  if (
    !value ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    invalidMount();
  }
  requireDigest(value.digest);
  return deepFreeze(
    canonicalSnapshot({ id: value.id, version: value.version, digest: value.digest }).value,
  );
}

function rootsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sameProgram(left: PinnedProgram, right: PinnedProgram): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function programKey(program: PinnedProgram): string {
  return stableTupleHash([program.id, program.version, program.digest]);
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("text/");
}

function requireDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new ResourceError("invalid_resource_manifest", "Invalid digest metadata");
  }
}

function invalidMount(): never {
  throw new ResourceError("resource_mount_conflict", "Invalid or conflicting resource mount");
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
