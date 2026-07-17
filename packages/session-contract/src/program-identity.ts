import type {
  DurableProgramFactory,
  DurableProgramManifest,
  DurableTool,
} from "./durable-types.ts";
import { canonicalJson, canonicalSnapshot, sha256 } from "./canonical.ts";
import { createPinnedDurableProgram, validateDurableManifest } from "./authoring.ts";
import { CrankError, type Json } from "./types.ts";

export const PROGRAM_ARTIFACT_IDENTITY_FORMAT = "sweatpants.program-artifact-identity.v1" as const;
export const PROGRAM_ARTIFACT_IDENTITY_DOMAIN = `${PROGRAM_ARTIFACT_IDENTITY_FORMAT}\n`;
export const PROGRAM_ARTIFACT_GENERATOR_VERSION = 1;

export interface ProgramArtifactIdentityInputV1 {
  readonly format: typeof PROGRAM_ARTIFACT_IDENTITY_FORMAT;
  readonly generatorVersion: number;
  readonly manifest: Omit<DurableProgramManifest, "digest">;
  readonly implementationArtifactDigest: string;
  readonly resourcePackageDigests: readonly string[];
}

export type ProgramIdentityProvenanceV1 =
  | {
      readonly kind: "generated-artifact";
      readonly format: typeof PROGRAM_ARTIFACT_IDENTITY_FORMAT;
      readonly generatorVersion: number;
      readonly identityInputDigest: string;
    }
  | { readonly kind: "asserted" };

export interface GeneratedProgramArtifactIdentityV1 {
  readonly digest: string;
  readonly input: ProgramArtifactIdentityInputV1;
  readonly provenance: Extract<ProgramIdentityProvenanceV1, { kind: "generated-artifact" }>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const INPUT_KEYS = [
  "format",
  "generatorVersion",
  "implementationArtifactDigest",
  "manifest",
  "resourcePackageDigests",
] as const;

/** Validates and canonicalizes every declared program artifact identity input. */
export function normalizeProgramArtifactIdentityInput(
  input: ProgramArtifactIdentityInputV1,
): ProgramArtifactIdentityInputV1 {
  if (!isRecord(input) || !hasExactKeys(input, INPUT_KEYS)) {
    invalidIdentity("identity input must use the closed v1 shape");
  }
  if (input.format !== PROGRAM_ARTIFACT_IDENTITY_FORMAT) {
    invalidIdentity("unsupported identity format");
  }
  if (!Number.isSafeInteger(input.generatorVersion) || input.generatorVersion <= 0) {
    invalidIdentity("generatorVersion must be a positive safe integer");
  }
  requireDigest(input.implementationArtifactDigest, "implementationArtifactDigest");
  if (!Array.isArray(input.resourcePackageDigests)) {
    invalidIdentity("resourcePackageDigests must be an array");
  }
  const resources = [...input.resourcePackageDigests];
  for (const digest of resources) {
    requireDigest(digest, "resourcePackageDigests");
  }
  resources.sort();
  for (let index = 1; index < resources.length; index += 1) {
    if (resources[index] === resources[index - 1]) {
      invalidIdentity("resourcePackageDigests must be duplicate-free");
    }
  }

  if (!isRecord(input.manifest) || "digest" in input.manifest) {
    invalidIdentity("manifest must omit digest");
  }
  // Ordinary durable-manifest validation remains the authority for descriptors,
  // effects, elicitations, and replay capabilities.
  validateDurableManifest({
    ...(input.manifest as Omit<DurableProgramManifest, "digest">),
    digest: "0".repeat(64),
  });

  return deepFreeze(
    canonicalSnapshot({
      format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
      generatorVersion: input.generatorVersion,
      manifest: input.manifest,
      implementationArtifactDigest: input.implementationArtifactDigest,
      resourcePackageDigests: resources,
    }).value as unknown as ProgramArtifactIdentityInputV1,
  );
}

/** Computes the exact domain-separated program digest from normalized declared artifacts. */
export function deriveProgramArtifactDigest(input: ProgramArtifactIdentityInputV1): string {
  const normalized = normalizeProgramArtifactIdentityInput(input);
  return sha256(PROGRAM_ARTIFACT_IDENTITY_DOMAIN + canonicalJson(normalized));
}

/** Creates immutable generated identity and provenance evidence. */
export function generateProgramArtifactIdentity(
  input: ProgramArtifactIdentityInputV1,
): GeneratedProgramArtifactIdentityV1 {
  const normalized = normalizeProgramArtifactIdentityInput(input);
  const digest = sha256(PROGRAM_ARTIFACT_IDENTITY_DOMAIN + canonicalJson(normalized));
  const identityInputDigest = sha256(canonicalJson(normalized));
  return deepFreeze({
    digest,
    input: normalized,
    provenance: {
      kind: "generated-artifact",
      format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
      generatorVersion: normalized.generatorVersion,
      identityInputDigest,
    },
  });
}

/** Creates a low-level pinned program only after generated identity evidence is re-derived. */
export function createGeneratedPinnedDurableProgram<I extends Json = Json, O extends Json = Json>(
  identity: GeneratedProgramArtifactIdentityV1,
  program: DurableProgramFactory<I, O>,
): DurableTool<I, O> {
  const checked = generateProgramArtifactIdentity(identity.input);
  if (
    identity.digest !== checked.digest ||
    canonicalJson(identity.provenance) !== canonicalJson(checked.provenance)
  ) {
    invalidIdentity("generated identity evidence is inconsistent");
  }
  const manifest = {
    ...(checked.input.manifest as Omit<DurableProgramManifest<I, O>, "digest">),
    digest: checked.digest,
  };
  return createPinnedDurableProgramWithIdentity(manifest, program, checked);
}

/** Validates binding provenance, optionally enforcing generated-only release policy. */
export function validateProgramIdentityProvenance(
  binding: Pick<DurableTool, "manifest" | "identityProvenance" | "identityArtifact">,
  options: { readonly releaseStrict?: boolean } = {},
): void {
  const provenance = binding.identityProvenance;
  if (!provenance || provenance.kind === "asserted") {
    if (options.releaseStrict) {
      throw new CrankError(
        "asserted_program_identity_forbidden",
        "Release-strict validation requires generated program identity",
      );
    }
    return;
  }
  const artifact = binding.identityArtifact;
  if (!artifact) {
    invalidIdentity("generated provenance requires identity artifact evidence");
  }
  const checked = generateProgramArtifactIdentity(artifact.input);
  if (
    checked.digest !== binding.manifest.digest ||
    checked.digest !== artifact.digest ||
    canonicalJson(checked.provenance) !== canonicalJson(provenance)
  ) {
    invalidIdentity("program digest and generated provenance disagree");
  }
}

/** Enforces release policy over an authored program inventory. */
export function validateProgramBindingsForRelease(
  bindings: Iterable<Pick<DurableTool, "manifest" | "identityProvenance" | "identityArtifact">>,
  options: { readonly releaseStrict?: boolean } = { releaseStrict: true },
): void {
  for (const binding of bindings) {
    validateProgramIdentityProvenance(binding, options);
  }
}

/** @internal constructor used to retain independently re-verifiable generated evidence. */
export function createPinnedDurableProgramWithIdentity<I extends Json, O extends Json>(
  manifest: DurableProgramManifest<I, O>,
  program: DurableProgramFactory<I, O>,
  identity: GeneratedProgramArtifactIdentityV1,
): DurableTool<I, O> {
  const tool = createPinnedDurableProgram(manifest, program);
  return Object.freeze({
    ...tool,
    identityProvenance: identity.provenance,
    identityArtifact: identity,
  });
}

function requireDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    invalidIdentity(`${field} must be lowercase SHA-256 hex`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = sortText(Object.keys(value));
  const expected = sortText(keys);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sortText(values: Iterable<string>): string[] {
  const result = [...values];
  // The copy keeps normalization nonmutating; ES2022 does not provide toSorted().
  // oxlint-disable-next-line unicorn/no-array-sort
  return result.sort();
}

function invalidIdentity(message: string): never {
  throw new CrankError("invalid_manifest", `Invalid program artifact identity: ${message}`);
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
