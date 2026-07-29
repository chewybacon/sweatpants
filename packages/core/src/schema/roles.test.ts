import { describe, expect, it } from "vitest";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema-descriptor";
import { parseToolResourceSchemaDescriptor } from "./roles.ts";

function descriptor(role: string) {
  return createPortableSchemaDescriptor({
    identity: `test/${role}`,
    role,
    version: "1",
    vendor: "test",
    inputProjection: true,
    outputProjection: true,
    fidelity: { input: "explicit", output: "explicit" },
  });
}

describe("tool/resource schema boundary", () => {
  it.each(["tool_parameters", "tool_output"])("accepts %s", (role) => {
    expect(parseToolResourceSchemaDescriptor(descriptor(role)).role).toBe(role);
  });

  it("rejects a program-owned role", () => {
    expect(() => parseToolResourceSchemaDescriptor(descriptor("program_input"))).toThrow(
      "Invalid tool/resource schema role",
    );
  });
});
