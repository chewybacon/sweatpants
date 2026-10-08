import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  assertJson,
  canonicalDigest,
  canonicalJson,
  canonicalSnapshot,
  cloneJson,
  hasControlCharacter,
  parseJsonText,
  parseJsonObject,
  requireJsonObject,
  sha256,
  stableTupleHash,
  replaceControlCharacters,
} from "../json.ts";

describe("foundation canonical JSON", () => {
  it("captures current values and detaches copies regardless of freezing", () => {
    const child = { value: 1 };
    const shallow = Object.freeze({ child });
    expect(canonicalJson(shallow)).toBe('{"child":{"value":1}}');
    child.value = 2;
    expect(canonicalJson(shallow)).toBe('{"child":{"value":2}}');
    Object.freeze(child);
    expect(canonicalJson(shallow)).toBe('{"child":{"value":2}}');
    const copy = cloneJson(shallow);
    copy.child.value = 3;
    expect(canonicalJson(shallow)).toBe('{"child":{"value":2}}');
    expect(canonicalJson(copy)).toBe('{"child":{"value":3}}');
    const keyed = Object.freeze(JSON.parse('{"__proto__":{"value":1},"constructor":2}'));
    expect(() => canonicalJson(keyed)).toThrow(CanonicalJsonError);
  });

  it("does not treat frozen array accessors as immutable data", () => {
    let reads = 0;
    const array = Object.freeze(
      Object.defineProperty([0], "0", {
        get() {
          reads++;
          return reads;
        },
      }),
    );
    expect(() => canonicalJson(array)).toThrow(CanonicalJsonError);
    expect(reads).toBe(0);
  });
  it("canonicalizes object keys and produces stable snapshot evidence", () => {
    const snapshot = canonicalSnapshot({ z: [true, -0], a: { y: "value" } });

    expect(snapshot.canonical).toBe('{"a":{"y":"value"},"z":[true,0]}');
    expect(snapshot.value).toEqual({ a: { y: "value" }, z: [true, 0] });
    expect(canonicalDigest(snapshot.value)).toBe(sha256(snapshot.canonical));
    // RFC ordering is lexical UTF-16, including integer-looking object keys.
    expect(canonicalJson({ "2": 2, "10": 10, "\uE000": 3, "𝄞": 4 })).toBe(
      '{"10":10,"2":2,"𝄞":4,"\uE000":3}',
    );
    expect(stableTupleHash(["a", "b"])).not.toBe(stableTupleHash(["a|b"]));
    expect(stableTupleHash(["a", "b"])).toMatch(/^[0-9a-f]{64}$/);
    expect(hasControlCharacter("safe")).toBe(false);
    expect(hasControlCharacter(`bad${String.fromCharCode(0)}`)).toBe(true);
    expect(replaceControlCharacters(`bad${String.fromCharCode(0)}value`)).toBe("bad value");
  });

  it("preserves canonical digests without requiring a snapshot", () => {
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(canonicalDigest({ b: -0, a: [true, null, "𝄞"] })).toBe(
      sha256(canonicalSnapshot({ a: [true, null, "𝄞"], b: 0 }).canonical),
    );
  });

  it("clones with the same normalization and key order as a canonical JSON round trip", () => {
    const shared = { z: -0, a: ["value"] };
    const input = {
      z: shared,
      a: shared,
      objects: [Object.assign(Object.create(null), { z: true, a: "null prototype" })],
      keys: { z: 1, "10": 2, "2": 3, "\uE000": 4, "𝄞": 5 },
    };

    const copied = cloneJson(input);
    const roundTrip = JSON.parse(canonicalJson(input));
    const snapshot = canonicalSnapshot(input);

    expect(JSON.stringify(copied)).toBe(JSON.stringify(roundTrip));
    expect(JSON.stringify(snapshot.value)).toBe(JSON.stringify(roundTrip));
    expect(snapshot.canonical).toBe(canonicalJson(input));
    expect(Object.getPrototypeOf(copied.objects[0])).toBe(Object.prototype);
    expect(Object.is(copied.z.z, 0)).toBe(true);
    expect(copied.z).not.toBe(copied.a);
    expect(copied.z).not.toBe(shared);
    copied.z.a.push("changed");
    expect(shared.a).toEqual(["value"]);
    expect(copied.a.a).toEqual(["value"]);
  });

  it("keeps snapshot values independent of the source and their canonical text", () => {
    const source = { z: { b: 2, a: 1 } };
    const snapshot = canonicalSnapshot(source);

    snapshot.value.z.a = 3;

    expect(source.z.a).toBe(1);
    expect(snapshot.canonical).toBe('{"z":{"a":1,"b":2}}');
    expect(Object.keys(snapshot.value.z)).toEqual(["a", "b"]);
  });

  it("applies the same rejection policy to cloning, snapshots, encoding, and digests", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("must not invoke accessors");
      },
    });
    const nonEnumerable = Object.defineProperty({}, "value", { value: 1 });
    const sparse = Array<string>(2);
    sparse[1] = "sparse";
    const values = [
      undefined,
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: BigInt(1) },
      { value: () => true },
      { value: "\ud800" },
      { "\udc00": true },
      { [Symbol("key")]: true },
      new Date(0),
      Object.assign([], { property: true }),
      cyclic,
      accessor,
      nonEnumerable,
      sparse,
    ];

    for (const value of values) {
      let expected: CanonicalJsonError | undefined;
      try {
        canonicalJson(value);
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalJsonError);
        expected = error as CanonicalJsonError;
      }
      expect(expected).toBeDefined();
      for (const operation of [cloneJson, canonicalSnapshot, canonicalDigest]) {
        expect(() => operation(value)).toThrow(expected);
      }
    }
  });

  it("rejects non-portable JSON without durable-domain error policy", () => {
    const sparse = Array<string>(2);
    sparse[1] = "sparse";

    expect(() => assertJson({ value: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(sparse)).toThrow(/sparse array slot/);
  });

  it("parses text into canonical Json instead of asserting JSON.parse output", () => {
    expect(parseJsonText('{"value":-0}')).toEqual({ value: 0 });
    expect(() => parseJsonText("1e400")).toThrow(/non-finite number/);
    expect(() => parseJsonText('"\\ud800"')).toThrow(/lone high surrogate/);
    expect(() => parseJsonText("not json")).toThrow(SyntaxError);
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
