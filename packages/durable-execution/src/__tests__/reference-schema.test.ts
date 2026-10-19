import { encodeCanonicalJson } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import { durableReferenceSchema } from "../reference-schema.ts";

describe("durable reference schema", () => {
  it("preserves optional metadata until serialization without changing the caller", () => {
    const input = {
      id: "reference",
      byteLength: undefined,
      version: undefined,
      integrity: undefined,
    };
    const value = durableReferenceSchema.parse(input);
    expect(value).toStrictEqual(input);
    expect(encodeCanonicalJson(value)).toBe(encodeCanonicalJson({ id: "reference" }));
    expect(Object.hasOwn(input, "byteLength")).toBe(true);
  });

  it("preserves zero length and supplied integrity metadata", () => {
    const input = {
      id: "reference",
      byteLength: 0,
      version: "1",
      integrity: { algorithm: "sha256", value: "digest" },
    };
    expect(durableReferenceSchema.parse(input)).toStrictEqual(input);
  });

  it.each([
    { id: "reference", extra: undefined },
    { id: "reference", byteLength: -1 },
    { id: "reference", version: "" },
    { id: "reference", integrity: { algorithm: "sha256", value: undefined } },
  ])("rejects malformed reference metadata: %j", (input) => {
    expect(durableReferenceSchema.safeParse(input).success).toBe(false);
  });
});
