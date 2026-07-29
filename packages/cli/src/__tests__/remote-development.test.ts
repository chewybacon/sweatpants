import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  createPinnedDurableProgram,
  generateProgramArtifactIdentity,
  sha256Bytes,
  type DurableTool,
} from "@sweatpants/session-contract";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/foundation/schema-descriptor";

import { defineConfig, definePrograms } from "../config.ts";
import {
  InMemoryActiveCollectionStore,
  InMemoryVersionedObjectStore,
  RemoteDevelopmentError,
  activateReadyCollection,
  assertActivationAuthority,
  buildDevelopmentCollection,
  bundleConfiguredPrograms,
  decodeDevelopmentCollectionArchive,
  environmentSlug,
  parseSemverMajor,
  publishDevelopmentCollection,
  reconstructCollectionProgram,
  verifyCollectionReadiness,
} from "../remote-development.ts";

const encoder = new TextEncoder();

function programEntryBytes(marker: string, version = "1.2.3"): Uint8Array {
  return encoder.encode(`
const schema = ${JSON.stringify(ANY_JSON_SCHEMA_DESCRIPTOR)};
export default {
  durability: "crank_native",
  manifest: {
    programId: "test.program",
    version: ${JSON.stringify(version)},
    digest: "${"a".repeat(64)}",
    inputSchema: schema,
    outputSchema: schema,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" }
  },
  program: function* () { return ${JSON.stringify(marker)}; },
  identityProvenance: { kind: "asserted" },
  artifacts: { catalog: [] }
};
`);
}

function generatedTool(entryBytes: Uint8Array, version = "1.2.3"): DurableTool {
  const identity = generateProgramArtifactIdentity({
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion: 1,
    manifest: {
      programId: "test.program",
      version,
      inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: false,
        structuredChildren: false,
        replay: "strict",
      },
    },
    implementationArtifactDigest: sha256Bytes(entryBytes),
    resourcePackageDigests: [],
  });
  return createGeneratedPinnedDurableProgram(identity, function* () {
    return null;
  });
}

function build(programs = ["alpha", "beta"]) {
  return buildDevelopmentCollection({
    builderVersion: "0.1.0",
    evaluatorAbi: "agentcore-development-v1",
    platform: "linux-arm64",
    programs: programs.map((publicKey) => {
      const entryBytes = programEntryBytes(publicKey);
      return {
        publicKey,
        program: generatedTool(entryBytes),
        entryBytes,
        schemaCatalogBytes: encoder.encode(`{"program":${JSON.stringify(publicKey)}}`),
      };
    }),
  });
}

const environment = {
  accountId: "123456789012",
  region: "us-east-1",
  project: "sweatpants",
  owner: "developer",
  name: "dev",
} as const;

describe("remote development config", () => {
  it("normalizes explicit roots without scanning", () => {
    const entry = encoder.encode("export default 1;\n");
    const program = generatedTool(entry);
    const programs = definePrograms({
      only_declared: {
        program,
        source: { module: "./src/program.ts", export: "program" },
      },
    });
    const config = defineConfig({
      app: { command: ["pnpm", "dev"] },
      programs,
      development: { remote: { provider: "agentcore", environment: "dev", region: "us-east-1" } },
    });
    expect(Object.keys(config.programs)).toEqual(["only_declared"]);
    expect(config.programs["only_declared"]?.placement).toBeUndefined();
    expect(config.programs["only_declared"]?.source.module).toBe("src/program.ts");
    expect(() => definePrograms({})).toThrow(/at least one program/);
    expect(() =>
      definePrograms({
        only_declared: { program, source: { module: "../escape.ts", export: "program" } },
      }),
    ).toThrow(/escapes/);
  });
});

describe("deterministic development collections", () => {
  it("bundles explicit source entries deterministically across checkout paths", async () => {
    const left = await mkdtemp(join(tmpdir(), "sweatpants-left-"));
    const right = await mkdtemp(join(tmpdir(), "sweatpants-right-"));
    const source = `
const schema = ${JSON.stringify(ANY_JSON_SCHEMA_DESCRIPTOR)};
export const program = {
  durability: "crank_native",
  manifest: {
    programId: "source.program",
    version: "1.0.0",
    digest: "${"a".repeat(64)}",
    inputSchema: schema,
    outputSchema: schema,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" }
  },
  program: function* () { return null; },
  identityProvenance: { kind: "asserted" },
  artifacts: { catalog: [] }
};
`;
    try {
      await Promise.all([
        writeFile(join(left, "program.mjs"), source),
        writeFile(join(right, "program.mjs"), source),
      ]);
      const load = async (root: string) =>
        (await import(
          `${pathToFileURL(join(root, "program.mjs")).href}?root=${encodeURIComponent(root)}`
        )) as {
          program: DurableTool;
        };
      const buildAt = async (root: string) => {
        const loaded = await load(root);
        return bundleConfiguredPrograms({
          projectRoot: root,
          programs: definePrograms({
            root: { program: loaded.program, source: { module: "program.mjs", export: "program" } },
          }),
          builderVersion: "0.1.0",
          evaluatorAbi: "v1",
          platform: "linux",
        });
      };
      const [first, second] = await Promise.all([buildAt(left), buildAt(right)]);
      expect(second.archiveBytes).toEqual(first.archiveBytes);
      expect(second.manifest.programs["root"]?.implementationArtifactDigest).toBe(
        first.manifest.programs["root"]?.implementationArtifactDigest,
      );
      expect(second.manifest.programs["root"]?.manifestDigest).not.toBe("a".repeat(64));
    } finally {
      await Promise.all([
        rm(left, { recursive: true, force: true }),
        rm(right, { recursive: true, force: true }),
      ]);
    }
  });

  it("is deterministic and preserves independent program identity", () => {
    const first = build();
    const second = build(["beta", "alpha"]);
    expect(second.archiveBytes).toEqual(first.archiveBytes);
    expect(second.manifest.collectionDigest).toBe(first.manifest.collectionDigest);

    const changedEntry = encoder.encode('export default "changed";\n');
    const unchangedBetaEntry = programEntryBytes("beta");
    const changed = buildDevelopmentCollection({
      builderVersion: "0.1.0",
      evaluatorAbi: "agentcore-development-v1",
      platform: "linux-arm64",
      programs: [
        {
          publicKey: "alpha",
          program: generatedTool(changedEntry),
          entryBytes: changedEntry,
          schemaCatalogBytes: encoder.encode('{"program":"alpha"}'),
        },
        {
          publicKey: "beta",
          program: generatedTool(unchangedBetaEntry),
          entryBytes: unchangedBetaEntry,
          schemaCatalogBytes: encoder.encode('{"program":"beta"}'),
        },
      ],
    });
    expect(changed.manifest.collectionDigest).not.toBe(first.manifest.collectionDigest);
    expect(changed.manifest.programs["beta"]).toEqual(first.manifest.programs["beta"]);
  });

  it("round-trips exact archive bytes and rejects tampering", () => {
    const collection = build(["alpha"]);
    expect(
      decodeDevelopmentCollectionArchive(collection.archiveBytes, collection.objectDigest).manifest,
    ).toEqual(collection.manifest);
    const tampered = Uint8Array.from(collection.archiveBytes);
    const changedIndex = tampered.length - 2;
    tampered[changedIndex] = tampered[changedIndex]! ^ 1;
    expect(() =>
      decodeDevelopmentCollectionArchive(tampered, collection.objectDigest),
    ).toThrowError(expect.objectContaining({ code: "object_digest_mismatch" }));
  });

  it("promotes authored identity after bundling and rejects imports and invalid SemVer", () => {
    const entryBytes = encoder.encode("export default null;\n");
    const asserted = createPinnedDurableProgram(
      {
        ...generatedTool(entryBytes).manifest,
        digest: "a".repeat(64),
      },
      function* () {
        return null;
      },
    );
    const base = {
      builderVersion: "0.1.0",
      evaluatorAbi: "v1",
      platform: "linux",
      programs: [],
    } as const;
    const promoted = buildDevelopmentCollection({
      ...base,
      programs: [
        {
          publicKey: "root",
          program: asserted,
          entryBytes,
          schemaCatalogBytes: encoder.encode("{}"),
        },
      ],
    });
    expect(promoted.manifest.programs["root"]?.manifestDigest).not.toBe(asserted.manifest.digest);
    expect(Buffer.from(entryBytes).toString("utf8")).not.toContain(
      promoted.manifest.programs["root"]?.manifestDigest,
    );
    const releaseEntry = promoted.manifest.programs["root"]!;
    const reconstructed = reconstructCollectionProgram(asserted, releaseEntry, entryBytes);
    expect(reconstructed.manifest.digest).toBe(releaseEntry.manifestDigest);
    expect(reconstructed.identityProvenance.kind).toBe("generated-artifact");
    const importing = encoder.encode(
      'import value from "mutable-package"; export default value;\n',
    );
    expect(() =>
      buildDevelopmentCollection({
        ...base,
        programs: [
          {
            publicKey: "root",
            program: generatedTool(importing),
            entryBytes: importing,
            schemaCatalogBytes: encoder.encode("{}"),
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "prohibited_runtime_import" }));
    expect(() => parseSemverMajor("1")).toThrowError(
      expect.objectContaining({ code: "invalid_semver" }),
    );
    expect(() => parseSemverMajor("01.2.3")).toThrowError(RemoteDevelopmentError);
  });
});

describe("publication, readiness, and activation", () => {
  it("publishes an exact version, verifies readiness, and activates with CAS fencing", async () => {
    const collection = build(["alpha"]);
    const objects = new InMemoryVersionedObjectStore();
    const published = await publishDevelopmentCollection({
      store: objects,
      bucket: "development-artifacts",
      key: `${environmentSlug(environment)}/${collection.manifest.collectionDigest}.json`,
      archiveBytes: collection.archiveBytes,
      manifest: collection.manifest,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(published.versionId).toBe("1");
    const readiness = await verifyCollectionReadiness({
      store: objects,
      collection: published,
      evaluatorReleaseId: "evaluator-1",
      evaluatorAbi: "agentcore-development-v1",
    });
    const records = new InMemoryActiveCollectionStore();
    const snapshot = await records.read(environment);
    const active = await activateReadyCollection({
      store: records,
      environment,
      writerId: "writer-a",
      expected: snapshot,
      readiness,
    });
    expect(active.record.epoch).toBe(1);
    await expect(
      assertActivationAuthority({ store: records, environment, writerId: "writer-a", epoch: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      activateReadyCollection({
        store: records,
        environment,
        writerId: "writer-b",
        expected: snapshot,
        readiness,
      }),
    ).rejects.toMatchObject({
      code: "activation_authority_lost",
    });
  });
});
