import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  computePortableSchemaDigest,
  createDurableSchemaRegistry,
  createPortableSchemaDescriptor,
  safeSchemaIssues,
  validateRegisteredSchema,
} from "../index.ts";

function descriptor(identity: string) {
  return createPortableSchemaDescriptor({
    identity,
    role: "program_input",
    version: "1",
    vendor: "test",
    inputProjection: { type: "string" },
    outputProjection: { type: "string" },
    fidelity: { input: "explicit", output: "explicit" },
  });
}

describe("DurableSchemaRegistry", () => {
  it("awaits async Standard Schema validation through Effection and canonicalizes output", async () => {
    const schemaDescriptor = descriptor("test/async-default-transform");
    const registry = createDurableSchemaRegistry([
      {
        descriptor: schemaDescriptor,
        schema: {
          "~standard": {
            version: 1,
            vendor: "test",
            async validate(value) {
              await Promise.resolve();
              return typeof value === "string"
                ? { value: value.trim().toUpperCase() }
                : { issues: [{ message: "secret payload rejected", path: ["value"] }] };
            },
          },
        },
      },
    ]);
    await expect(
      run(function* () {
        return yield* validateRegisteredSchema(registry, schemaDescriptor.digest, "  okay ");
      }),
    ).resolves.toEqual({ status: "ok", value: "OKAY" });
  });

  it("returns unavailable for a missing retained validator bundle", async () => {
    await expect(
      run(function* () {
        return yield* validateRegisteredSchema(createDurableSchemaRegistry(), "f".repeat(64), {});
      }),
    ).resolves.toEqual({ status: "unavailable", digest: "f".repeat(64) });
  });

  it("rejects non-JSON schema output and bounds issue diagnostics", async () => {
    const schemaDescriptor = descriptor("test/non-json-output");
    const registry = createDurableSchemaRegistry([
      {
        descriptor: schemaDescriptor,
        schema: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: () => ({ value: new Date() }),
          },
        },
      },
    ]);
    await expect(
      run(function* () {
        return yield* validateRegisteredSchema(registry, schemaDescriptor.digest, "date");
      }),
    ).resolves.toEqual({
      status: "invalid",
      issues: [{ message: "validated value is not bounded canonical JSON" }],
    });
    expect(safeSchemaIssues([{ message: "x".repeat(900), path: [{ key: "password" }] }])).toEqual([
      { message: "x".repeat(512), path: "password" },
    ]);
  });

  it("commits descriptor digest to semantic identity, role, projections, and fidelity", () => {
    const value = descriptor("test/digest");
    expect(value.digest).toBe(
      computePortableSchemaDigest({
        identity: value.identity,
        role: value.role,
        version: value.version,
        vendor: value.vendor,
        inputProjection: value.inputProjection,
        outputProjection: value.outputProjection,
        fidelity: value.fidelity,
      }),
    );
    expect(descriptor("test/digest-v2").digest).not.toBe(value.digest);
  });
});
