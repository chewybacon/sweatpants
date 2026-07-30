import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  sha256Bytes,
} from "@sweatpants/foundation";

import {
  DEFAULT_RESOURCE_LIMITS,
  RESOURCE_PACKAGE_DOMAIN,
  RESOURCE_PACKAGE_FORMAT,
  ResourceError,
  sortedResourceValues,
  type ResourceContentBindings,
  type ResourceFileDeclaration,
  type ResourceFileManifestV1,
  type ResourceFileRefV1,
  type ResourceLimits,
  type ResourcePackage,
  type ResourcePackageManifestV1,
} from "./types.ts";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const declarationBytes = new WeakMap<ResourceFileDeclaration, Uint8Array>();
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACKAGE_ID_RE = /^[a-z][a-z0-9._-]{0,127}$/;
const MEDIA_TYPE_RE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"]*"))*$/;
const LIMIT_KEYS = Object.keys(DEFAULT_RESOURCE_LIMITS) as Array<keyof ResourceLimits>;

export interface DefineResourcePackageOptions {
  readonly id: string;
  readonly version: string;
  readonly files: Readonly<Record<string, ResourceFileDeclaration>>;
  readonly limits?: Partial<ResourceLimits>;
}

export interface ResourceFileOptions {
  readonly mediaType?: string;
}

/** Creates an authored UTF-8 resource with BOM and line endings normalized. */
export function textResource(
  value: string | Uint8Array,
  options: ResourceFileOptions = {},
): ResourceFileDeclaration {
  let text: string;
  try {
    if (typeof value === "string") {
      assertUnicode(value);
      text = value;
    } else {
      text = fatalDecoder.decode(new Uint8Array(value));
    }
  } catch {
    throw new ResourceError("invalid_resource_manifest", "Invalid UTF-8 text resource");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return declaration(
    "text",
    options.mediaType ?? "text/plain; charset=utf-8",
    encoder.encode(text),
  );
}

/** Creates a canonical RFC-8785-style JSON resource. */
export function jsonResource(value: unknown): ResourceFileDeclaration {
  let canonical: string;
  try {
    canonical = canonicalJson(assertJson(value));
  } catch {
    throw new ResourceError("invalid_resource_manifest", "Invalid canonical JSON resource");
  }
  return declaration("json", "application/json", encoder.encode(canonical));
}

/** Creates an inert binary resource while preserving every supplied byte. */
export function binaryResource(
  value: Uint8Array | ArrayBuffer,
  mediaType: string,
): ResourceFileDeclaration {
  const bytes =
    value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
  return declaration("binary", mediaType, bytes);
}

/** Rehydrates deterministic generated bindings without enormous numeric array literals. */
export function binaryResourceFromBase64(
  encoded: string,
  mediaType: string,
): ResourceFileDeclaration {
  return binaryResource(decodeResourceBase64(encoded), mediaType);
}

/** Encodes exact bytes for deterministic generated resource modules. */
export function encodeResourceBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += second === undefined ? "=" : alphabet[(value >>> 6) & 63];
    output += third === undefined ? "=" : alphabet[value & 63];
  }
  return output;
}

function decodeResourceBase64(encoded: string): Uint8Array {
  if (
    typeof encoded !== "string" ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    invalidManifest();
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((encoded.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const first = alphabet.indexOf(encoded[index]!);
    const second = alphabet.indexOf(encoded[index + 1]!);
    const third = encoded[index + 2] === "=" ? 0 : alphabet.indexOf(encoded[index + 2]!);
    const fourth = encoded[index + 3] === "=" ? 0 : alphabet.indexOf(encoded[index + 3]!);
    const value = (first << 18) | (second << 12) | (third << 6) | fourth;
    output[offset++] = (value >>> 16) & 0xff;
    if (offset < output.length) {
      output[offset++] = (value >>> 8) & 0xff;
    }
    if (offset < output.length) {
      output[offset++] = value & 0xff;
    }
  }
  return output;
}

/** Builds an immutable package and copies every caller-owned byte buffer. */
export function defineResourcePackage(options: DefineResourcePackageOptions): ResourcePackage {
  if (!isPlainRecord(options) || !hasOnlyKeys(options, ["id", "version", "files", "limits"])) {
    invalidManifest();
  }
  requirePackageId(options.id);
  requireVersion(options.version);
  if (!isPlainRecord(options.files)) {
    invalidManifest();
  }
  const limits = resolveResourceLimits(options.limits);
  const normalized = normalizeFileDeclarations(options.files, limits);
  const files: Record<string, ResourceFileManifestV1> = {};
  const bytes = new Map<string, Uint8Array>();
  for (const entry of normalized) {
    files[entry.path] = {
      digest: sha256Bytes(entry.bytes),
      size: entry.bytes.byteLength,
      mediaType: entry.mediaType,
    };
    bytes.set(entry.path, new Uint8Array(entry.bytes));
  }
  const projection = {
    format: RESOURCE_PACKAGE_FORMAT,
    id: options.id,
    version: options.version,
    files,
  };
  const manifest = deepFreeze(
    canonicalSnapshot({
      ...projection,
      digest: sha256(RESOURCE_PACKAGE_DOMAIN + canonicalJson(projection)),
    }).value as ResourcePackageManifestV1,
  );
  return createPackage(manifest, bytes, limits);
}

/** Parses the closed v1 manifest shape and verifies its package digest. */
export function parseResourcePackageManifest(value: unknown): ResourcePackageManifestV1 {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["format", "id", "version", "digest", "files"])
    ) {
      invalidManifest();
    }
    if (value["format"] !== RESOURCE_PACKAGE_FORMAT) {
      invalidManifest();
    }
    requirePackageId(value["id"]);
    requireVersion(value["version"]);
    requireDigest(value["digest"]);
    if (!isPlainRecord(value["files"])) {
      invalidManifest();
    }
    const files: Record<string, ResourceFileManifestV1> = {};
    const collisions = new Map<string, string>();
    for (const [rawPath, rawFile] of Object.entries(value["files"])) {
      const path = normalizeResourcePath(rawPath, DEFAULT_RESOURCE_LIMITS);
      assertPathCollision(collisions, rawPath, path);
      if (!isPlainRecord(rawFile) || !hasExactKeys(rawFile, ["digest", "mediaType", "size"])) {
        invalidManifest();
      }
      requireDigest(rawFile["digest"]);
      requireSize(rawFile["size"]);
      requireMediaType(rawFile["mediaType"]);
      files[path] = {
        digest: rawFile["digest"],
        size: rawFile["size"],
        mediaType: rawFile["mediaType"],
      };
    }
    const projection = {
      format: RESOURCE_PACKAGE_FORMAT,
      id: value["id"],
      version: value["version"],
      files,
    };
    if (sha256(RESOURCE_PACKAGE_DOMAIN + canonicalJson(projection)) !== value["digest"]) {
      throw new ResourceError("resource_digest_mismatch", "Resource package digest mismatch");
    }
    return deepFreeze(
      canonicalSnapshot({ ...projection, digest: value["digest"] })
        .value as ResourcePackageManifestV1,
    );
  } catch (error) {
    if (error instanceof ResourceError) {
      throw error;
    }
    invalidManifest();
  }
}

/** Rehydrates a package only after proving complete bindings against the exact manifest. */
export function bindResourcePackage(
  manifestValue: unknown,
  bindings: Readonly<Record<string, Uint8Array>> | ResourceContentBindings,
  limitsValue?: Partial<ResourceLimits>,
): ResourcePackage {
  const manifest = parseResourcePackageManifest(manifestValue);
  const limits = resolveResourceLimits(limitsValue);
  const supplied = new Map<string, Uint8Array>();
  if (isResourceBindings(bindings)) {
    for (const path of bindings.paths()) {
      const value = bindings.read(path);
      if (value) {
        supplied.set(path, value);
      }
    }
  } else {
    if (!isPlainRecord(bindings)) {
      invalidManifest();
    }
    for (const [path, value] of Object.entries(bindings)) {
      if (!(value instanceof Uint8Array)) {
        invalidManifest();
      }
      supplied.set(path, new Uint8Array(value));
    }
  }
  verifyCompleteResourceBindings(manifest, supplied, limits);
  return createPackage(manifest, supplied, limits);
}

/** Validates and freezes one limits object used consistently at every layer. */
export function resolveResourceLimits(value?: Partial<ResourceLimits>): ResourceLimits {
  if (value !== undefined && (!isPlainRecord(value) || !hasOnlyKeys(value, LIMIT_KEYS))) {
    throw new ResourceError("invalid_resource_manifest", "Invalid resource limits");
  }
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...value } as ResourceLimits;
  for (const key of LIMIT_KEYS) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new ResourceError("invalid_resource_manifest", "Invalid resource limits");
    }
  }
  return Object.freeze(limits);
}

/** Normalizes a relative POSIX resource path independent of host filesystem behavior. */
export function normalizeResourcePath(
  path: string,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")) {
    invalidPath();
  }
  assertUnicode(path);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || hasControlCharacter(path)) {
    invalidPath();
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalidPath();
  }
  const normalized = segments.map((segment) => segment.normalize("NFC")).join("/");
  if (encoder.encode(normalized).byteLength > limits.maxPathBytes) {
    throw new ResourceError("resource_limit_exceeded", "Resource path exceeds configured limit");
  }
  return normalized;
}

/** Projects an exact structured file reference to its canonical logical URI. */
export function formatResourceUri(ref: ResourceFileRefV1): string {
  requirePackageId(ref.packageId);
  requireDigest(ref.packageDigest);
  const path = normalizeResourcePath(ref.path);
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `resource://${ref.packageId}@${ref.packageDigest}/${encoded}`;
}

/** Parses only canonical digest-qualified resource URIs. */
export function parseResourceUri(uri: string): ResourceFileRefV1 {
  if (typeof uri !== "string") {
    invalidPath();
  }
  const match = /^resource:\/\/([a-z][a-z0-9._-]{0,127})@([0-9a-f]{64})\/(.+)$/.exec(uri);
  if (!match) {
    invalidPath();
  }
  let path: string;
  try {
    path = match[3]!
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    invalidPath();
  }
  const ref = Object.freeze({
    packageId: match[1]!,
    packageDigest: match[2]!,
    path: normalizeResourcePath(path!),
  });
  if (formatResourceUri(ref) !== uri) {
    invalidPath();
  }
  return ref;
}

export function verifyCompleteResourceBindings(
  manifest: ResourcePackageManifestV1,
  bindings: ReadonlyMap<string, Uint8Array>,
  limits: ResourceLimits,
): void {
  const paths = Object.keys(manifest.files);
  if (paths.length > limits.maxFiles || bindings.size !== paths.length) {
    digestMismatch();
  }
  let aggregate = 0;
  for (const path of paths) {
    const bytes = bindings.get(path);
    const file = manifest.files[path]!;
    if (!bytes || bytes.byteLength !== file.size || sha256Bytes(bytes) !== file.digest) {
      digestMismatch();
    }
    if (bytes.byteLength > limits.maxFileBytes) {
      limitExceeded();
    }
    aggregate += bytes.byteLength;
    if (aggregate > limits.maxPackageBytes) {
      limitExceeded();
    }
  }
  for (const path of bindings.keys()) {
    if (!(path in manifest.files)) {
      digestMismatch();
    }
  }
}

function normalizeFileDeclarations(
  files: Readonly<Record<string, ResourceFileDeclaration>>,
  limits: ResourceLimits,
): Array<{ path: string; mediaType: string; bytes: Uint8Array }> {
  const entries = Object.entries(files);
  if (entries.length > limits.maxFiles) {
    limitExceeded();
  }
  const collisions = new Map<string, string>();
  const output: Array<{ path: string; mediaType: string; bytes: Uint8Array }> = [];
  let aggregate = 0;
  for (const [rawPath, source] of entries) {
    const path = normalizeResourcePath(rawPath, limits);
    assertPathCollision(collisions, rawPath, path);
    if (!isPlainRecord(source) || !hasExactKeys(source, ["kind", "mediaType"])) {
      invalidManifest();
    }
    if (!(["text", "json", "binary"] as unknown[]).includes(source.kind)) {
      invalidManifest();
    }
    requireMediaType(source.mediaType);
    const stored = declarationBytes.get(source);
    if (!stored) {
      invalidManifest();
    }
    const bytes = new Uint8Array(stored);
    if (bytes.byteLength > limits.maxFileBytes) {
      limitExceeded();
    }
    aggregate += bytes.byteLength;
    if (aggregate > limits.maxPackageBytes) {
      limitExceeded();
    }
    output.push({ path, mediaType: source.mediaType, bytes });
  }
  return sortedResourceValues(output, (left, right) => compareText(left.path, right.path));
}

function declaration(
  kind: ResourceFileDeclaration["kind"],
  mediaType: string,
  bytes: Uint8Array,
): ResourceFileDeclaration {
  requireMediaType(mediaType);
  const value = Object.freeze({ kind, mediaType });
  declarationBytes.set(value, new Uint8Array(bytes));
  return value;
}

function createPackage(
  manifest: ResourcePackageManifestV1,
  source: ReadonlyMap<string, Uint8Array>,
  limits: ResourceLimits,
): ResourcePackage {
  const stored = new Map([...source].map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  const paths = Object.freeze(sortedResourceValues(stored.keys(), compareText));
  const bindings: ResourceContentBindings = Object.freeze({
    size: stored.size,
    has: (path: string) => stored.has(path),
    paths: () => paths,
    read: (path: string) => {
      const bytes = stored.get(path);
      return bytes ? new Uint8Array(bytes) : undefined;
    },
  });
  return Object.freeze({ manifest, bindings, limits });
}

function assertPathCollision(
  collisions: Map<string, string>,
  raw: string,
  normalized: string,
): void {
  const folded = unicodeSimpleCaseFold(normalized);
  const previous = collisions.get(folded);
  if (previous !== undefined && previous !== raw) {
    invalidPath();
  }
  collisions.set(folded, raw);
}

function unicodeSimpleCaseFold(value: string): string {
  return [...value]
    .map((character) => {
      const upper = character.toUpperCase();
      // Unicode simple folding is one-code-point-to-one-code-point. Multi-code-point
      // uppercase expansions (for example ß -> SS) are deliberately not folded.
      return [...upper].length === 1 ? upper : character;
    })
    .join("");
}

function requirePackageId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PACKAGE_ID_RE.test(value)) {
    invalidManifest();
  }
}

function requireVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    invalidManifest();
  }
  try {
    assertUnicode(value);
  } catch {
    invalidManifest();
  }
  if (encoder.encode(value).byteLength > 128) {
    invalidManifest();
  }
}

function requireDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    invalidManifest();
  }
}

function requireSize(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidManifest();
  }
}

function requireMediaType(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !MEDIA_TYPE_RE.test(value)) {
    invalidManifest();
  }
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("unicode");
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = sortedResourceValues(Object.keys(value), compareText);
  const sorted = sortedResourceValues(expected, compareText);
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isResourceBindings(value: unknown): value is ResourceContentBindings {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ResourceContentBindings).paths === "function" &&
    typeof (value as ResourceContentBindings).read === "function",
  );
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidManifest(): never {
  throw new ResourceError("invalid_resource_manifest", "Invalid resource package manifest");
}
function invalidPath(): never {
  throw new ResourceError("invalid_resource_path", "Invalid resource path");
}
function digestMismatch(): never {
  throw new ResourceError("resource_digest_mismatch", "Resource package binding mismatch");
}
function limitExceeded(): never {
  throw new ResourceError("resource_limit_exceeded", "Resource package exceeds configured limit");
}
