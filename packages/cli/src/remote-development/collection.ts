import { parse } from "acorn";
import { z } from "zod";

import {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  generateProgramArtifactIdentity,
  parseDurableManifest,
  verifyProgramIdentityProvenance,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { canonicalJson, sha256, sha256Bytes as hashBytes } from "@sweatpants/foundation";

import type { ConfiguredDurableTool } from "../config.ts";

import {
  DEVELOPMENT_COLLECTION_DOMAIN,
  DEVELOPMENT_COLLECTION_FORMAT,
  RemoteDevelopmentError,
  type CollectionFileEntryV1,
  type CollectionProgramEntryV1,
  type DevelopmentCollectionManifestV1,
} from "./types.ts";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const PUBLIC_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const ARCHIVE_FORMAT = "sweatpants.development-collection-archive.v1" as const;
const boundedStringSchema = z.string().min(1).max(256).refine((value) => !hasControlCharacter(value));
const digestSchema = z.string().regex(SHA256_RE);
const collectionFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  bytes: z.number().int().nonnegative().safe(),
  digest: digestSchema,
  kind: z.enum(["program", "schema-catalog", "resource-descriptor", "registry"]),
});
const collectionProgramSchema = z.strictObject({
  publicKey: z.string().regex(PUBLIC_KEY_RE),
  programId: boundedStringSchema,
  version: z.string().regex(SEMVER_RE),
  compatibilityMajor: z.number().int().nonnegative().safe(),
  manifestDigest: digestSchema,
  entrypoint: z.string().min(1).max(1024),
  implementationArtifactDigest: digestSchema,
  schemaCatalogDigest: digestSchema,
  resourcePackageDigests: z.array(digestSchema).max(4096),
});
const developmentCollectionManifestSchema = z.strictObject({
  format: z.literal(DEVELOPMENT_COLLECTION_FORMAT),
  builder: z.strictObject({
    name: z.literal("@sweatpants/cli"),
    version: boundedStringSchema,
  }),
  collectionDigest: digestSchema,
  evaluatorAbi: boundedStringSchema,
  target: z.strictObject({
    runtime: z.literal("node"),
    module: z.literal("esm"),
    platform: boundedStringSchema,
  }),
  programs: z.record(z.string().regex(PUBLIC_KEY_RE), collectionProgramSchema),
  files: z.array(collectionFileSchema).max(16_384),
});
const archiveDocumentSchema = z.strictObject({
  format: z.literal(ARCHIVE_FORMAT),
  manifest: developmentCollectionManifestSchema,
  files: z.record(z.string(), z.string().max(128 * 1024 * 1024)),
});

export interface ProgramBundleInput {
  readonly publicKey: string;
  readonly program: ConfiguredDurableTool;
  readonly entryBytes: Uint8Array;
  readonly schemaCatalogBytes: Uint8Array;
  readonly resourceDescriptors?: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
  readonly allowedEvaluatorImports?: readonly string[];
}

export interface BuildDevelopmentCollectionInput {
  readonly builderVersion: string;
  readonly evaluatorAbi: string;
  readonly platform: string;
  readonly programs: readonly ProgramBundleInput[];
}

export interface BuiltDevelopmentCollection {
  readonly manifest: DevelopmentCollectionManifestV1;
  readonly archiveBytes: Uint8Array;
  readonly objectDigest: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

interface ArchiveDocumentV1 {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly manifest: DevelopmentCollectionManifestV1;
  readonly files: Readonly<Record<string, string>>;
}

export function buildDevelopmentCollection(
  input: BuildDevelopmentCollectionInput,
): BuiltDevelopmentCollection {
  requireBounded(input.builderVersion, "builder version");
  requireBounded(input.evaluatorAbi, "evaluator ABI");
  requireBounded(input.platform, "target platform");
  if (input.programs.length === 0) {
    fail("invalid_program_root", "Collection requires at least one program");
  }

  const programs: Record<string, CollectionProgramEntryV1> = {};
  const contents = new Map<string, { bytes: Uint8Array; kind: CollectionFileEntryV1["kind"] }>();
  const pins = new Set<string>();
  for (const bundle of sortValues(input.programs, (left, right) =>
    compareText(left.publicKey, right.publicKey),
  )) {
    if (!PUBLIC_KEY_RE.test(bundle.publicKey) || programs[bundle.publicKey]) {
      fail(
        "invalid_program_root",
        `Invalid or duplicate program root ${bounded(bundle.publicKey)}`,
      );
    }
    assertAuthoredBundle(bundle);
    const major = parseSemverMajor(bundle.program.manifest.version);
    const entrypoint = `programs/${bundle.publicKey}.mjs`;
    const schemaPath = `schemas/${bundle.publicKey}.json`;
    addFile(contents, entrypoint, bundle.entryBytes, "program");
    addFile(contents, schemaPath, bundle.schemaCatalogBytes, "schema-catalog");

    const resources = sortValues(bundle.resourceDescriptors ?? [], (left, right) =>
      compareText(left.path, right.path),
    );
    const resourceDigests: string[] = [];
    for (const resource of resources) {
      const path = normalizeRelativePath(resource.path);
      const digest = sha256Bytes(resource.bytes);
      resourceDigests.push(digest);
      addFile(contents, path, resource.bytes, "resource-descriptor");
    }
    resourceDigests.sort(compareText);
    rejectDuplicates(resourceDigests, "resource package digest");

    const implementationArtifactDigest = sha256Bytes(bundle.entryBytes);
    const releaseProgram = constructReleaseProgram(
      bundle,
      implementationArtifactDigest,
      resourceDigests,
    );
    const pin = `${releaseProgram.manifest.programId}@${releaseProgram.manifest.version}#${releaseProgram.manifest.digest}`;
    if (pins.has(pin)) {
      fail("invalid_collection_manifest", `Duplicate program pin for ${bundle.publicKey}`);
    }
    pins.add(pin);
    programs[bundle.publicKey] = Object.freeze({
      publicKey: bundle.publicKey,
      programId: releaseProgram.manifest.programId,
      version: releaseProgram.manifest.version,
      compatibilityMajor: major,
      manifestDigest: releaseProgram.manifest.digest,
      entrypoint,
      implementationArtifactDigest,
      schemaCatalogDigest: sha256Bytes(bundle.schemaCatalogBytes),
      resourcePackageDigests: Object.freeze(resourceDigests),
    });
  }

  const registryBytes = encodeUtf8(canonicalJson({ programs }));
  addFile(contents, "registry.json", registryBytes, "registry");
  const files = sortValues(
    [...contents.entries()].map(([path, value]) =>
      Object.freeze({
        path,
        bytes: value.bytes.byteLength,
        digest: sha256Bytes(value.bytes),
        kind: value.kind,
      }),
    ),
    (left, right) => compareText(left.path, right.path),
  );

  const withoutDigest = {
    format: DEVELOPMENT_COLLECTION_FORMAT,
    builder: { name: "@sweatpants/cli" as const, version: input.builderVersion },
    evaluatorAbi: input.evaluatorAbi,
    target: { runtime: "node" as const, module: "esm" as const, platform: input.platform },
    programs,
  };
  const collectionDigest = sha256(
    DEVELOPMENT_COLLECTION_DOMAIN + canonicalJson({ manifest: withoutDigest, files }),
  );
  const manifest: DevelopmentCollectionManifestV1 = deepFreeze({
    ...withoutDigest,
    collectionDigest,
    files,
  });
  parseDevelopmentCollectionManifest(manifest);
  const encodedFiles: Record<string, string> = {};
  for (const [path, value] of sortValues(contents.entries(), ([left], [right]) =>
    compareText(left, right),
  )) {
    encodedFiles[path] = Buffer.from(value.bytes).toString("base64");
  }
  const archiveBytes = encodeUtf8(
    canonicalJson({
      format: ARCHIVE_FORMAT,
      manifest,
      files: encodedFiles,
    } satisfies ArchiveDocumentV1),
  );
  return Object.freeze({
    manifest,
    archiveBytes,
    objectDigest: sha256Bytes(archiveBytes),
    files: readonlyMap(contents),
  });
}

export function decodeDevelopmentCollectionArchive(
  bytes: Uint8Array,
  expectedObjectDigest?: string,
): BuiltDevelopmentCollection {
  if (expectedObjectDigest !== undefined && sha256Bytes(bytes) !== expectedObjectDigest) {
    fail("object_digest_mismatch", "Collection archive object digest differs");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("invalid_collection_manifest", "Collection archive is not valid JSON");
  }
  const parsedArchive = archiveDocumentSchema.safeParse(value);
  if (!parsedArchive.success) {
    fail("invalid_collection_manifest", "Collection archive must use the closed v1 shape");
  }
  const archive = parsedArchive.data;
  const manifest = verifyDevelopmentCollectionManifest(archive.manifest);
  const contents = new Map<string, { bytes: Uint8Array; kind: CollectionFileEntryV1["kind"] }>();
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  if (Object.keys(archive.files).length !== expectedPaths.size) {
    fail("invalid_collection_manifest", "Archive file inventory differs from manifest");
  }
  for (const file of manifest.files) {
    const encoded = archive.files[file.path];
    if (typeof encoded !== "string") {
      fail("invalid_collection_manifest", `Missing archive file ${file.path}`);
    }
    const fileBytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (fileBytes.byteLength !== file.bytes || sha256Bytes(fileBytes) !== file.digest) {
      fail("artifact_digest_mismatch", `Archive file integrity differs for ${file.path}`);
    }
    contents.set(file.path, { bytes: fileBytes, kind: file.kind });
  }
  const archiveBytes = Uint8Array.from(bytes);
  return Object.freeze({
    manifest,
    archiveBytes,
    objectDigest: sha256Bytes(archiveBytes),
    files: readonlyMap(contents),
  });
}

export function parseDevelopmentCollectionManifest(
  value: unknown,
): DevelopmentCollectionManifestV1 {
  const parsed = developmentCollectionManifestSchema.safeParse(value);
  if (!parsed.success) {
    fail("invalid_collection_manifest", "Collection manifest must use the closed v1 shape");
  }
  return verifyDevelopmentCollectionManifest(parsed.data);
}

function verifyDevelopmentCollectionManifest(
  value: z.infer<typeof developmentCollectionManifestSchema>,
): DevelopmentCollectionManifestV1 {
  const rawBuilder = value.builder;
  const rawTarget = value.target;
  const rawPrograms = value.programs;
  const rawFiles = value.files;
  if (Object.keys(rawPrograms).length === 0) {
    fail("invalid_collection_manifest", "Collection programs are required");
  }
  const programs: Record<string, CollectionProgramEntryV1> = {};
  const entrypoints = new Set<string>();
  const pins = new Set<string>();
  for (const publicKey of sortValues(Object.keys(rawPrograms), compareText)) {
    const entry = rawPrograms[publicKey]!;
    if (entry.publicKey !== publicKey) {
      fail("invalid_collection_manifest", `Invalid program entry ${bounded(publicKey)}`);
    }
    const major = parseSemverMajor(entry.version);
    if (entry["compatibilityMajor"] !== major) {
      fail("invalid_collection_manifest", `Compatibility major differs for ${publicKey}`);
    }
    const entrypoint = normalizeRelativePath(entry.entrypoint);
    const resourcePackageDigests = [...entry.resourcePackageDigests];
    if (!isSorted(resourcePackageDigests)) {
      fail("invalid_collection_manifest", `Resource digests are not sorted for ${publicKey}`);
    }
    rejectDuplicates(resourcePackageDigests, "resource package digest");
    if (entrypoints.has(entrypoint)) {
      fail("invalid_collection_manifest", `Duplicate entrypoint ${entrypoint}`);
    }
    entrypoints.add(entrypoint);
    const pin = `${entry["programId"]}@${entry["version"]}#${entry["manifestDigest"]}`;
    if (pins.has(pin)) {
      fail("invalid_collection_manifest", `Duplicate program pin for ${publicKey}`);
    }
    pins.add(pin);
    programs[publicKey] = deepFreeze({
      publicKey,
      programId: entry["programId"],
      version: entry.version,
      compatibilityMajor: major,
      manifestDigest: entry["manifestDigest"],
      entrypoint,
      implementationArtifactDigest: entry["implementationArtifactDigest"],
      schemaCatalogDigest: entry["schemaCatalogDigest"],
      resourcePackageDigests,
    });
  }
  const files = rawFiles.map((file) => Object.freeze({ ...file, path: normalizeRelativePath(file.path) }));
  if (!isSorted(files.map((file) => file.path))) {
    fail("invalid_collection_manifest", "Collection files are not path-sorted");
  }
  rejectDuplicates(
    files.map((file) => file.path),
    "collection path",
  );
  for (const entry of Object.values(programs)) {
    const file = files.find((candidate) => candidate.path === entry.entrypoint);
    if (!file || file.kind !== "program" || file.digest !== entry.implementationArtifactDigest) {
      fail("invalid_collection_manifest", `Program entry file differs for ${entry.publicKey}`);
    }
  }
  const withoutDigest = {
    format: DEVELOPMENT_COLLECTION_FORMAT,
    builder: { name: "@sweatpants/cli" as const, version: rawBuilder["version"] },
    evaluatorAbi: value["evaluatorAbi"],
    target: { runtime: "node" as const, module: "esm" as const, platform: rawTarget["platform"] },
    programs,
  };
  const expected = sha256(
    DEVELOPMENT_COLLECTION_DOMAIN + canonicalJson({ manifest: withoutDigest, files }),
  );
  if (expected !== value["collectionDigest"]) {
    fail("collection_digest_mismatch", "Collection digest differs");
  }
  return deepFreeze({ ...withoutDigest, collectionDigest: value["collectionDigest"], files });
}

export function reconstructCollectionProgram(
  authoredProgram: ConfiguredDurableTool,
  entry: CollectionProgramEntryV1,
  entryBytes: Uint8Array,
): ConfiguredDurableTool {
  verifyDevelopmentProgramEntry(entry, authoredProgram, entryBytes);
  const { digest: _authoredDigest, ...manifest } = authoredProgram.manifest;
  const identity = generateProgramArtifactIdentity({
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
    manifest: manifest as Omit<DurableProgramManifest, "digest">,
    implementationArtifactDigest: entry.implementationArtifactDigest,
    resourcePackageDigests: entry.resourcePackageDigests,
  });
  if (identity.digest !== entry.manifestDigest) {
    fail(
      "artifact_digest_mismatch",
      `Generated program identity differs for ${bounded(entry.publicKey)}`,
    );
  }
  const releaseProgram = createGeneratedPinnedDurableProgram(identity, authoredProgram.program);
  verifyProgramIdentityProvenance(releaseProgram, { releaseStrict: true });
  return releaseProgram;
}

export function parseSemverMajor(version: unknown): number {
  if (typeof version !== "string") {
    fail("invalid_semver", "Program version must be SemVer 2.0.0");
  }
  const match = SEMVER_RE.exec(version);
  if (!match) {
    fail("invalid_semver", `Invalid program SemVer ${bounded(version)}`);
  }
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major)) {
    fail("invalid_semver", "Program major exceeds safe integer range");
  }
  return major;
}

function verifyDevelopmentProgramEntry(
  entry: CollectionProgramEntryV1,
  authoredProgram: ConfiguredDurableTool,
  entryBytes: Uint8Array,
): void {
  if (
    sha256Bytes(entryBytes) !== entry.implementationArtifactDigest ||
    authoredProgram.manifest.programId !== entry.programId ||
    authoredProgram.manifest.version !== entry.version ||
    parseSemverMajor(entry.version) !== entry.compatibilityMajor
  ) {
    fail(
      "artifact_digest_mismatch",
      `Imported program contract differs for ${bounded(entry.publicKey)}`,
    );
  }
}

function assertAuthoredBundle(bundle: ProgramBundleInput): void {
  try {
    parseDurableManifest(bundle.program.manifest);
  } catch {
    fail(
      "invalid_program_root",
      `Program root ${bounded(bundle.publicKey)} has an invalid manifest`,
    );
  }
  if (typeof bundle.program.program !== "function") {
    fail(
      "invalid_program_root",
      `Program root ${bounded(bundle.publicKey)} has no executable factory`,
    );
  }
  assertClosedImports(bundle.entryBytes, new Set(bundle.allowedEvaluatorImports ?? []));
}

function constructReleaseProgram(
  bundle: ProgramBundleInput,
  implementationArtifactDigest: string,
  resourcePackageDigests: readonly string[],
): ConfiguredDurableTool {
  const { digest: _authoredDigest, ...manifest } = bundle.program.manifest;
  const identity = generateProgramArtifactIdentity({
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
    manifest: manifest as Omit<DurableProgramManifest, "digest">,
    implementationArtifactDigest,
    resourcePackageDigests,
  });
  const releaseProgram = createGeneratedPinnedDurableProgram(identity, bundle.program.program);
  try {
    verifyProgramIdentityProvenance(releaseProgram, { releaseStrict: true });
  } catch {
    fail(
      "non_release_strict_program",
      `Generated release identity differs for ${bounded(bundle.publicKey)}`,
    );
  }
  return releaseProgram;
}

function assertClosedImports(bytes: Uint8Array, allowlist: ReadonlySet<string>): void {
  let root: unknown;
  try {
    root = parse(Buffer.from(bytes).toString("utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    fail("prohibited_runtime_import", "Program bundle is not valid evaluator JavaScript");
  }
  walkSyntax(root, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      const source = literalString(node["source"]);
      if (source !== undefined) {
        requireAllowedImport(source, allowlist);
      }
    }
    if (node.type === "ImportExpression") {
      const source = literalString(node["source"]);
      if (source === undefined) {
        fail("prohibited_runtime_import", "Program bundle contains mutable runtime resolution");
      }
      requireAllowedImport(source, allowlist);
    }
    if (
      node.type === "CallExpression" &&
      isSyntaxNode(node["callee"]) &&
      node["callee"].type === "Identifier" &&
      node["callee"]["name"] === "require"
    ) {
      fail("prohibited_runtime_import", "Program bundle contains CommonJS runtime resolution");
    }
  });
}

function requireAllowedImport(specifier: string, allowlist: ReadonlySet<string>): void {
  if (!allowlist.has(specifier)) {
    fail(
      "prohibited_runtime_import",
      `Program bundle imports prohibited module ${bounded(specifier)}`,
    );
  }
}

interface SyntaxNode extends Record<string, unknown> {
  readonly type: string;
}

function walkSyntax(value: unknown, visit: (node: SyntaxNode) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      walkSyntax(child, visit);
    }
    return;
  }
  if (!isSyntaxNode(value)) {
    return;
  }
  visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key !== "start" && key !== "end") {
      walkSyntax(child, visit);
    }
  }
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return isRecord(value) && typeof value["type"] === "string";
}

function literalString(value: unknown): string | undefined {
  return isSyntaxNode(value) && value.type === "Literal" && typeof value["value"] === "string"
    ? value["value"]
    : undefined;
}

function addFile(
  files: Map<string, { bytes: Uint8Array; kind: CollectionFileEntryV1["kind"] }>,
  path: string,
  bytes: Uint8Array,
  kind: CollectionFileEntryV1["kind"],
): void {
  const normalized = normalizeRelativePath(path);
  if (files.has(normalized)) {
    fail("invalid_collection_manifest", `Duplicate collection path ${normalized}`);
  }
  files.set(normalized, { bytes: Uint8Array.from(bytes), kind });
}

function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value) ||
    /%2e|%2f|%5c/iu.test(value)
  ) {
    fail("invalid_collection_manifest", `Invalid collection path ${bounded(value)}`);
  }
  return value;
}

function readonlyMap(source: Map<string, { bytes: Uint8Array }>): ReadonlyMap<string, Uint8Array> {
  return new Map([...source].map(([path, value]) => [path, Uint8Array.from(value.bytes)]));
}

function sha256Bytes(bytes: Uint8Array): string {
  return hashBytes(bytes);
}

function encodeUtf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function requireBounded(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 256 || hasControlCharacter(value)) {
    fail("invalid_collection_manifest", `${field} must be a bounded string`);
  }
}

function rejectDuplicates(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    fail("invalid_collection_manifest", `Duplicate ${field}`);
  }
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) <= 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortValues<T>(values: Iterable<T>, compare: (left: T, right: T) => number): T[] {
  const result = [...values];
  // oxlint-disable-next-line unicorn/no-array-sort
  return result.sort(compare);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bounded(value: unknown): string {
  return [...String(value)]
    .map((character) => (character.charCodeAt(0) < 32 ? "?" : character))
    .join("")
    .slice(0, 160);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
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

function fail(
  code: ConstructorParameters<typeof RemoteDevelopmentError>[0],
  message: string,
): never {
  throw new RemoteDevelopmentError(code, message);
}
