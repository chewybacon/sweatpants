import { describe, expect, it } from "vitest";
import {
  SchemaDescriptorError,
  createPortableSchemaDescriptor,
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
