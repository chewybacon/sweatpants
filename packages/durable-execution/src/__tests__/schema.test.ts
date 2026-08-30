import { describe, expect, it } from "vitest";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { parseProgramSchemaDescriptor } from "../schema.ts";

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

describe("program schema boundary", () => {
  it.each(["program_input", "program_output", "elicit_response", "elicit_context"])(
    "accepts %s",
    (role) => expect(parseProgramSchemaDescriptor(descriptor(role)).role).toBe(role),
  );

  it("rejects an effect-owned role", () => {
    expect(() => parseProgramSchemaDescriptor(descriptor("effect_input"))).toThrow(
      "Invalid program schema role",
    );
  });
});
