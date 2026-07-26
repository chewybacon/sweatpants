import {
  PROGRAM_ARTIFACT_IDENTITY_DOMAIN,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  PROGRAM_INTERFACE_IDENTITY_DOMAIN,
  PROGRAM_INTERFACE_IDENTITY_FORMAT,
  PROGRAM_INTERFACE_GENERATOR_VERSION,
  type DurableProgramFactory,
  type DurableProgramManifest,
  type DurableTool,
  type GeneratedProgramArtifactIdentityV1,
  type GeneratedProgramInterfaceIdentityV1,
  type ProgramArtifactIdentityInputV1,
  type ProgramIdentityProvenanceV1,
} from "./durable-types.ts";
import { canonicalJson, canonicalSnapshot, sha256 } from "./canonical.ts";
import { createPinnedDurableProgram, validateDurableManifest } from "./authoring.ts";
import { CrankError, type Json } from "./types.ts";

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

  // SAFETY: validateDurableManifest above rejects any manifest this identity
  // input could carry, and canonicalSnapshot re-serializes through assertJson,
  // so the value is both shape-checked and JSON-representable.
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

/** Derives an honest interface-only identity from the complete durable manifest contract. */
export function generateProgramInterfaceIdentity(
  manifest: Omit<DurableProgramManifest, "digest">,
): GeneratedProgramInterfaceIdentityV1 {
  validateDurableManifest({ ...manifest, digest: "0".repeat(64) });
  const input = canonicalSnapshot({
    format: PROGRAM_INTERFACE_IDENTITY_FORMAT,
    generatorVersion: PROGRAM_INTERFACE_GENERATOR_VERSION,
    manifest,
  }).value;
  const serialized = canonicalJson(input);
  return deepFreeze({
    digest: sha256(PROGRAM_INTERFACE_IDENTITY_DOMAIN + serialized),
    provenance: {
      kind: "generated-interface",
      format: PROGRAM_INTERFACE_IDENTITY_FORMAT,
      generatorVersion: PROGRAM_INTERFACE_GENERATOR_VERSION,
      identityInputDigest: sha256(serialized),
    },
  });
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

interface ProgramIdentityBindingEvidence {
  readonly manifest: DurableProgramManifest;
  readonly identityProvenance: ProgramIdentityProvenanceV1;
  readonly identityArtifact?: GeneratedProgramArtifactIdentityV1;
}

/** Validates binding provenance, optionally enforcing generated-only release policy. */
export function validateProgramIdentityProvenance(
  binding: ProgramIdentityBindingEvidence,
  options: { readonly releaseStrict?: boolean } = {},
): void {
  const provenance = binding.identityProvenance;
  if (!provenance || provenance.kind === "asserted") {
    if (options.releaseStrict) {
      throw new CrankError(
        "asserted_program_identity_forbidden",
        "Release-strict validation requires generated artifact identity",
      );
    }
    return;
  }
  if (provenance.kind === "generated-interface") {
    const { digest: _digest, ...manifest } = binding.manifest;
    const checked = generateProgramInterfaceIdentity(
      manifest as Omit<DurableProgramManifest, "digest">,
    );
    if (
      checked.digest !== binding.manifest.digest ||
      canonicalJson(checked.provenance) !== canonicalJson(provenance)
    ) {
      invalidIdentity("program digest and generated interface provenance disagree");
    }
    if (options.releaseStrict) {
      throw new CrankError(
        "interface_program_identity_forbidden",
        "Release-strict validation requires an implementation artifact identity",
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

/** Enforces implementation-artifact identity policy over an authored program inventory. */
export function validateProgramBindingsForRelease(
  bindings: Iterable<ProgramIdentityBindingEvidence>,
  options: { readonly releaseStrict?: boolean } = { releaseStrict: true },
): void {
  for (const binding of bindings) {
    validateProgramIdentityProvenance(binding, options);
  }
}

/** Creates a runnable program pinned only to its declared interface, never its executor source. */
export function createInterfaceDerivedPinnedDurableProgram<
  I extends Json = Json,
  O extends Json = Json,
>(
  manifest: Omit<DurableProgramManifest<I, O>, "digest">,
  program: DurableProgramFactory<I, O>,
): DurableTool<I, O> {
  const identity = generateProgramInterfaceIdentity(manifest);
  const tool = createPinnedDurableProgram({ ...manifest, digest: identity.digest }, program);
  return Object.freeze({ ...tool, identityProvenance: identity.provenance });
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
