import { describe, expect, it } from "vitest";
import {
  SchemaDescriptorError,
  createPortableSchemaDescriptor,
  computePortableSchemaDigest,
  parsePortableSchemaDescriptor,
  portableSchemaDescriptorParser,
  standardSchemaOf,
  type SchemaBinding,
} from "../schema.ts";

const fields = {
  identity: "example/custom",
  role: "domain_custom_role",
  version: "1",
  vendor: "example",
  inputProjection: { type: "string" },
  outputProjection: { type: "string" },
  fidelity: { input: "explicit", output: "explicit" } as const,
};

describe("portable schema descriptor mechanics", () => {
  it("accepts a bounded domain-owned role and preserves it through parsing", () => {
    const descriptor = createPortableSchemaDescriptor(fields);
    expect(descriptor.role).toBe("domain_custom_role");
    expect(parsePortableSchemaDescriptor(descriptor)).toEqual(descriptor);
    expect(portableSchemaDescriptorParser.parse(descriptor)).toEqual({
      ok: true,
      value: descriptor,
    });
    expect(portableSchemaDescriptorParser.parse({ ...descriptor, extra: true }).ok).toBe(false);

    const binding: SchemaBinding<typeof descriptor> = {
      descriptor,
      schema: standardSchemaOf("example", (value) => ({ value })),
    };
    expect(binding.descriptor).toBe(descriptor);
  });

  it.each(["", "x".repeat(129)])("rejects invalid bounded role %j", (role) => {
    expect(() => createPortableSchemaDescriptor({ ...fields, role })).toThrow(
      SchemaDescriptorError,
    );
  });
});

describe("portable descriptor boundary ownership", () => {
  it("detaches and freezes projections without changing the committed digest", () => {
    const projection = { properties: { z: { type: "number" }, a: { enum: [-0, 1] } } };
    const input = { ...fields, inputProjection: projection, outputProjection: false };
    const descriptor = createPortableSchemaDescriptor(input);
    expect(descriptor.digest).toBe(computePortableSchemaDigest(input));
    const restored = parsePortableSchemaDescriptor(JSON.parse(JSON.stringify(descriptor)));
    expect(restored).toEqual(descriptor);
    expect(Object.isFrozen(restored.inputProjection)).toBe(true);
    expect(Object.isFrozen(descriptor.inputProjection)).toBe(true);
    expect(
      Object.isFrozen((descriptor.inputProjection as typeof projection).properties.a.enum),
    ).toBe(true);
    projection.properties.a.enum.push(2);
    expect((descriptor.inputProjection as typeof projection).properties.a.enum).toEqual([0, 1]);
    expect(() => parsePortableSchemaDescriptor({ ...descriptor, outputProjection: true })).toThrow(
      SchemaDescriptorError,
    );
  });

  it("rejects non-JSON external projections without invoking object accessors", () => {
    const descriptor = createPortableSchemaDescriptor(fields);
    let reads = 0;
    const accessor = {
      get type() {
        reads++;
        return "string";
      },
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const inputProjection of [
      accessor,
      cycle,
      { value: Infinity },
      { value: undefined },
      new Date(),
      { value: "\ud800" },
    ]) {
      expect(() => parsePortableSchemaDescriptor({ ...descriptor, inputProjection })).toThrow(
        SchemaDescriptorError,
      );
    }
    expect(reads).toBe(0);
  });
});
