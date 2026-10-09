import { describe, expect, it } from "vitest";
import { canonicalDigest, sha256 } from "@sweatpants/foundation";
import { assertInlineSize, encodeInlineJson } from "../program-values.ts";

describe("inline JSON encoding", () => {
  it("returns canonical text that can supply the durable digest without encoding the value again", () => {
    const value = { z: "😀", a: "é" };
    const canonical = '{"a":"é","z":"😀"}';
    const limit = new TextEncoder().encode(canonical).byteLength;
    const encoded = encodeInlineJson(value, limit);
    expect(encoded).toBe(canonical);
    expect(sha256(encoded)).toBe(canonicalDigest(value));
    expect(value).toEqual({ z: "😀", a: "é" });
    expect(() => encodeInlineJson(value, limit - 1)).toThrow(`Canonical payload is ${limit} bytes`);
  });

  it("preserves the assertion-only API and counts UTF-8 bytes instead of string length", () => {
    expect(assertInlineSize("😀", 6)).toBeUndefined();
    expect(() => assertInlineSize("😀", 5)).toThrow("Canonical payload is 6 bytes");
    expect(encodeInlineJson(null, 4)).toBe("null");
    expect(() => encodeInlineJson(null, 3)).toThrow("Canonical payload is 4 bytes");
  });
});
