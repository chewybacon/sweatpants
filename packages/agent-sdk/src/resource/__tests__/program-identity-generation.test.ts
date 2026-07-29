import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  type ProgramArtifactIdentityInputV1,
} from "@sweatpants/durable-execution";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";

import { generateProgramIdentityModule } from "../index.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function identityInput(generatorVersion = 1): ProgramArtifactIdentityInputV1 {
  return {
    format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    generatorVersion,
    implementationArtifactDigest: "1".repeat(64),
    resourcePackageDigests: ["2".repeat(64)],
    manifest: {
      programId: "generated.fixture",
      version: "1",
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
  };
}

describe("generated program identity modules", () => {
  it("writes deterministic path-free output and detects every stale identity change", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-program-identity-"));
    temporary.push(root);
    const outputFile = join(root, "identity.generated.ts");
    const written = await generateProgramIdentityModule({
      input: identityInput(),
      outputFile,
      mode: "write",
    });
    await expect(
      generateProgramIdentityModule({ input: identityInput(), outputFile, mode: "verify" }),
    ).resolves.toEqual(written);
    const source = await readFile(outputFile, "utf8");
    expect(source).not.toContain(root);
    expect(source).not.toMatch(/generatedAt|timestamp/i);
    await expect(
      generateProgramIdentityModule({
        input: identityInput(2),
        outputFile,
        mode: "verify",
      }),
    ).rejects.toMatchObject({ code: "stale_generated_program_identity" });
  });
});
