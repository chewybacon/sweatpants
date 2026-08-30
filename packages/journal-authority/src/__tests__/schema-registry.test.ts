import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  computePortableSchemaDigest,
  createPortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { safeSchemaIssues } from "@sweatpants/foundation/schema-validation";
import { createDurableSchemaRegistry, parseRegisteredSchema } from "../schema-registry.ts";

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

describe("authority runtime schema registry", () => {
  it("rejects asynchronous validation without running an async operation", async () => {
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
                : { issues: [{ message: "rejected", path: ["value"] }] };
            },
          },
        },
      },
    ]);
    await expect(
      run(function* () {
        return parseRegisteredSchema(registry, schemaDescriptor.digest, "  okay ");
      }),
    ).resolves.toEqual({ status: "schema-error", reason: "async-unsupported" });
  });

  it("returns unavailable for an absent retained validator", async () => {
    await expect(
      run(function* () {
        return parseRegisteredSchema(createDurableSchemaRegistry(), "f".repeat(64), {});
      }),
    ).resolves.toEqual({ status: "unavailable", digest: "f".repeat(64) });
  });

  it("rejects non-JSON output and bounds diagnostics", async () => {
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
        return parseRegisteredSchema(registry, schemaDescriptor.digest, "date");
      }),
    ).resolves.toEqual({
      status: "invalid",
      issues: [{ message: "validated value is not bounded canonical JSON" }],
    });
    expect(safeSchemaIssues([{ message: "x".repeat(900), path: [{ key: "password" }] }])).toEqual([
      { message: "x".repeat(512), path: "password" },
    ]);
  });

  it("uses the generic descriptor's complete digest identity", () => {
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
  });
});
