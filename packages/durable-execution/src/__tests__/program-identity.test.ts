import { describe, expect, it } from "vitest";

import {
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createPinnedDurableProgram,
  createGeneratedPinnedDurableProgram,
  createInterfaceDerivedPinnedDurableProgram,
  deriveProgramArtifactDigest,
  generateProgramArtifactIdentity,
  generateProgramInterfaceIdentity,
  normalizeProgramArtifactIdentityInput,
  verifyProgramBindingsForRelease,
  verifyProgramIdentityProvenance,
  type ProgramArtifactIdentityInputV1,
} from "@sweatpants/durable-execution";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";

const manifest = {
  programId: "identity.test",
  version: "1",
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: {
    durableEmissions: false,
    structuredChildren: false,
    replay: "strict" as const,
  },
};

function input(resources: string[] = []): ProgramArtifactIdentityInputV1 {
  return {
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion: 1,
    manifest,
    implementationArtifactDigest: "1".repeat(64),
    resourcePackageDigests: resources,
  };
}

describe("program artifact identity", () => {
  it("normalizes resource order and derives a domain-separated digest", () => {
    const left = input(["b".repeat(64), "a".repeat(64)]);
    const right = input(["a".repeat(64), "b".repeat(64)]);
    expect(normalizeProgramArtifactIdentityInput(left).resourcePackageDigests).toEqual(
      right.resourcePackageDigests,
    );
    expect(deriveProgramArtifactDigest(input())).toBe(
      "5483c5142f90af4adbc5815df1dcff1e4cabf69744f5093f4cd4a509cfa7afab",
    );
    expect(deriveProgramArtifactDigest(right)).toBe(deriveProgramArtifactDigest(left));
    expect(deriveProgramArtifactDigest(left)).not.toBe(
      deriveProgramArtifactDigest({ ...left, implementationArtifactDigest: "2".repeat(64) }),
    );
    expect(() =>
      normalizeProgramArtifactIdentityInput(input(["a".repeat(64), "a".repeat(64)])),
    ).toThrow(/duplicate-free/);
  });

  it("constructs generated bindings and detects provenance disagreement", () => {
    const identity = generateProgramArtifactIdentity(input());
    expect(identity.provenance.identityInputDigest).toBe(
      "b3b5e64ec3e716895665fd5d4b1f3bd57f0da5945ea5517514ed8554e2d7b64a",
    );
    const binding = createGeneratedPinnedDurableProgram(identity, function* () {
      return null;
    });
    expect(binding.manifest.digest).toBe(identity.digest);
    expect(binding.identityProvenance.kind).toBe("generated-artifact");
    expect(() => verifyProgramIdentityProvenance(binding, { releaseStrict: true })).not.toThrow();
    expect(() =>
      verifyProgramIdentityProvenance({
        ...binding,
        manifest: { ...binding.manifest, digest: "f".repeat(64) },
      }),
    ).toThrow(/disagree/);
  });

  it("derives an honest interface-only identity without claiming executor coverage", () => {
    const identity = generateProgramInterfaceIdentity(manifest);
    const duplicate = generateProgramInterfaceIdentity({ ...manifest });
    const changed = generateProgramInterfaceIdentity({ ...manifest, version: "2" });
    const binding = createInterfaceDerivedPinnedDurableProgram(manifest, function* () {
      return null;
    });

    expect(identity).toEqual(duplicate);
    expect(identity.digest).not.toBe(changed.digest);
    expect(binding.manifest.digest).toBe(identity.digest);
    expect(binding.identityProvenance).toEqual(identity.provenance);
    expect(() => verifyProgramIdentityProvenance(binding)).not.toThrow();
    expect(() => verifyProgramIdentityProvenance(binding, { releaseStrict: true })).toThrowError(
      expect.objectContaining({ code: "interface_program_identity_forbidden" }),
    );
  });

  it("keeps manually asserted low-level identities out of strict releases", () => {
    const pinnedManifest = { ...manifest, digest: "a".repeat(64) };
    const tool = createPinnedDurableProgram(pinnedManifest, function* () {
      return null;
    });
    expect(tool.identityProvenance).toEqual({ kind: "asserted" });
    expect(() => verifyProgramBindingsForRelease([tool])).toThrowError(
      expect.objectContaining({ code: "asserted_program_identity_forbidden" }),
    );
  });
});
