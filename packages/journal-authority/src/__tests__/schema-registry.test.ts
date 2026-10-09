import { run } from "effection";
import { JOURNAL_PAYLOAD_MAX_DEPTH } from "../contract/payload-limits.ts";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { describe, expect, it } from "vitest";
import {
  computePortableSchemaDigest,
  createPortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { safeSchemaIssues } from "@sweatpants/foundation/schema-validation";
import { createDurableSchemaRegistry, parseRegisteredSchema } from "../contract/schema-registry.ts";

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
  it("admits and detaches built-in JSON using the same policy as transformed output", () => {
    const registry = createDurableSchemaRegistry();
    const source = { nested: { value: -0 }, items: ["𝄞"] };
    const result = parseRegisteredSchema(registry, ANY_JSON_SCHEMA_DESCRIPTOR.digest, source);
    source.nested.value = 4;
    source.items.push("changed");
    expect(result).toEqual({ status: "ok", value: { nested: { value: 0 }, items: ["𝄞"] } });

    let accessorReads = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        accessorReads++;
        return "forbidden";
      },
    });
    for (const input of [
      undefined,
      new Date(),
      { number: NaN },
      Array(1),
      { text: "\ud800" },
      { [Symbol("key")]: true },
      accessor,
    ]) {
      expect(parseRegisteredSchema(registry, ANY_JSON_SCHEMA_DESCRIPTOR.digest, input).status).toBe(
        "invalid",
      );
    }
    expect(accessorReads).toBe(0);
  });

  it("bounds the transformed payload rather than its surrounding journal envelope", () => {
    const registry = createDurableSchemaRegistry();
    let payload: unknown = "leaf";
    for (let depth = 0; depth < JOURNAL_PAYLOAD_MAX_DEPTH; depth++) {
      payload = { child: payload };
    }
    expect(parseRegisteredSchema(registry, ANY_JSON_SCHEMA_DESCRIPTOR.digest, payload).status).toBe(
      "ok",
    );
    expect(
      parseRegisteredSchema(registry, ANY_JSON_SCHEMA_DESCRIPTOR.digest, { child: payload }).status,
    ).toBe("invalid");
  });

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

  it("detaches validated output from objects retained by the schema", () => {
    const schemaDescriptor = createPortableSchemaDescriptor({
      identity: "test/retained-output",
      role: "program_input",
      version: "1",
      vendor: "test",
      inputProjection: { type: "string" },
      outputProjection: { type: "object" },
      fidelity: { input: "explicit", output: "explicit" },
    });
    const retained = { nested: { choice: "first" }, choices: ["first", "second"] };
    const registry = createDurableSchemaRegistry([
      {
        descriptor: schemaDescriptor,
        schema: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: () => ({ value: retained }),
          },
        },
      },
    ]);

    const parsed = parseRegisteredSchema(registry, schemaDescriptor.digest, "choose");
    retained.nested.choice = "changed";
    retained.choices.push("third");

    expect(parsed).toEqual({
      status: "ok",
      value: { nested: { choice: "first" }, choices: ["first", "second"] },
    });
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
