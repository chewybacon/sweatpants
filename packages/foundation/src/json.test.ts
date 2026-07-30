import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  parseJsonObject,
  requireJsonObject,
  sha256,
  stableOpaqueId,
} from "./json.ts";

describe("foundation canonical JSON", () => {
  it("canonicalizes object keys and produces stable snapshot evidence", () => {
    const snapshot = canonicalSnapshot({ z: [true, -0], a: { y: "value" } });

    expect(snapshot.canonical).toBe('{"a":{"y":"value"},"z":[true,0]}');
    expect(snapshot.value).toEqual({ a: { y: "value" }, z: [true, 0] });
    expect(snapshot.sha).toBe(sha256(snapshot.canonical));
    expect(stableOpaqueId("payload", { a: 1 })).toBe(stableOpaqueId("payload", { a: 1 }));
  });

  it("rejects non-portable JSON without durable-domain error policy", () => {
    const sparse = Array<string>(2);
    sparse[1] = "sparse";

    expect(() => assertJson({ value: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(sparse)).toThrow(/sparse array slot/);
  });

  it("parses unknown keyed objects into fresh canonical JSON", () => {
    const input = { nested: { value: -0 } };
    const parsed = parseJsonObject(input);

    expect(parsed).toEqual({ nested: { value: 0 } });
    expect(parsed).not.toBe(input);
    expect(() => parseJsonObject([])).toThrow(/expected a keyed JSON object/);
  });

  it("narrows parsed JSON without cloning or walking it again", () => {
    const parsed = assertJson({ nested: { value: true } });
    const object = requireJsonObject(parsed);

    expect(object).toBe(parsed);
    expect(() => requireJsonObject(null)).toThrow(/expected a keyed JSON object/);
    expect(() => requireJsonObject([])).toThrow(/expected a keyed JSON object/);
  });
});
