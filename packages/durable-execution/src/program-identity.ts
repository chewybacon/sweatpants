import {
  PROGRAM_ARTIFACT_IDENTITY_DOMAIN,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  PROGRAM_INTERFACE_IDENTITY_DOMAIN,
  PROGRAM_INTERFACE_IDENTITY_FORMAT,
  PROGRAM_INTERFACE_GENERATOR_VERSION,
  type DurableProgramManifest,
  type GeneratedProgramArtifactIdentityV1,
  type GeneratedProgramInterfaceIdentityV1,
  type ProgramArtifactIdentityInputV1,
  type ProgramIdentityProvenanceV1,
} from "./program-contract.ts";
import type { DurableProgramFactory, DurableTool } from "./program-authoring.ts";
import { canonicalJson, failure, parser, sha256, success, type Json } from "@sweatpants/foundation";
import { createPinnedDurableProgram, parseDurableManifest } from "./program-authoring-runtime.ts";

import { CrankError } from "./errors.ts";
import { z } from "zod";

const ownedIdentityEvidence = new WeakMap<
  DurableProgramManifest,
  {
    provenance: ProgramIdentityProvenanceV1;
    artifact?: GeneratedProgramArtifactIdentityV1;
  }
>();

const SHA256_RE = /^[0-9a-f]{64}$/;
const programArtifactIdentityInputSchema = z.strictObject({
  format: z.literal(PROGRAM_ARTIFACT_IDENTITY_FORMAT),
  generatorVersion: z.number().int().positive().safe(),
  implementationArtifactDigest: z.string().regex(SHA256_RE),
  manifest: z
    .record(z.string(), z.json())
    .refine((manifest) => !("digest" in manifest), "manifest must omit digest"),
  resourcePackageDigests: z.array(z.string().regex(SHA256_RE)).max(16_384),
});

export const programArtifactIdentityInputParser = parser(
  programArtifactIdentityInputSchema,
).andThen((parsed) => {
  const resources = [...parsed.resourcePackageDigests].sort();
  for (let index = 1; index < resources.length; index += 1) {
    if (resources[index] === resources[index - 1]) {
      return failure<ProgramArtifactIdentityInputV1>({
        path: ["resourcePackageDigests", index],
        message: "resourcePackageDigests must be duplicate-free",
      });
    }
  }

  try {
    // Durable-manifest parsing remains authoritative for nested descriptors,
    // effects, elicitations, replay capabilities, and unknown-field policy.
    const validatedManifest = parseDurableManifest({
      ...parsed.manifest,
      digest: "0".repeat(64),
    });
    const { digest: _validationDigest, ...manifest } = validatedManifest;
    return success(
      deepFreeze({
        format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
        generatorVersion: parsed.generatorVersion,
        manifest,
        implementationArtifactDigest: parsed.implementationArtifactDigest,
        resourcePackageDigests: resources,
      }),
    );
  } catch {
    return failure<ProgramArtifactIdentityInputV1>({
      path: ["manifest"],
      message: "identity manifest is invalid",
    });
  }
});

/** Caller-owned mapping for generated identity construction. */
export function normalizeProgramArtifactIdentityInput(
  input: ProgramArtifactIdentityInputV1,
): ProgramArtifactIdentityInputV1 {
  const parsed = programArtifactIdentityInputParser.parse(input);
  if (!parsed.ok) {
    invalidIdentity(parsed.issues[0]?.message ?? "identity input must use the closed v1 shape");
  }
  return parsed.value;
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
  parseDurableManifest({ ...manifest, digest: "0".repeat(64) });
  const serialized = canonicalJson({
    format: PROGRAM_INTERFACE_IDENTITY_FORMAT,
    generatorVersion: PROGRAM_INTERFACE_GENERATOR_VERSION,
    manifest,
  });
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
  const canonical = canonicalJson(normalized);
  const digest = sha256(PROGRAM_ARTIFACT_IDENTITY_DOMAIN + canonical);
  const identityInputDigest = sha256(canonical);
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
export function verifyProgramIdentityProvenance(
  binding: ProgramIdentityBindingEvidence,
  options: { readonly releaseStrict?: boolean } = {},
): void {
  const provenance = binding.identityProvenance;
  const retained = ownedIdentityEvidence.get(binding.manifest);
  if (
    retained &&
    retained.provenance === provenance &&
    retained.artifact === binding.identityArtifact
  ) {
    if (options.releaseStrict && provenance.kind === "generated-interface") {
      throw new CrankError(
        "interface_program_identity_forbidden",
        "Release-strict validation requires an implementation artifact identity",
      );
    }
    return;
  }

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
export function verifyProgramBindingsForRelease(
  bindings: Iterable<ProgramIdentityBindingEvidence>,
  options: { readonly releaseStrict?: boolean } = { releaseStrict: true },
): void {
  for (const binding of bindings) {
    verifyProgramIdentityProvenance(binding, options);
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
  const result = Object.freeze({ ...tool, identityProvenance: identity.provenance });
  // Both the parsed manifest and generated evidence are privately owned and frozen.
  // Registries can check their identities without deriving the same digest again.
  ownedIdentityEvidence.set(result.manifest, { provenance: result.identityProvenance });
  return result;
}

/** @internal constructor used to retain independently re-verifiable generated evidence. */
export function createPinnedDurableProgramWithIdentity<I extends Json, O extends Json>(
  manifest: DurableProgramManifest<I, O>,
  program: DurableProgramFactory<I, O>,
  identity: GeneratedProgramArtifactIdentityV1,
): DurableTool<I, O> {
  const tool = createPinnedDurableProgram(manifest, program);
  const owned = deepFreeze(structuredClone(identity));
  const result = Object.freeze({
    ...tool,
    identityProvenance: owned.provenance,
    identityArtifact: owned,
  });
  verifyProgramIdentityProvenance(result);
  ownedIdentityEvidence.set(result.manifest, { provenance: owned.provenance, artifact: owned });
  return result;
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
