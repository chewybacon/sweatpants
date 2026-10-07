import { canonicalJson, sha256, sha256Bytes, type Json } from "@sweatpants/foundation";
import { expect, it } from "vitest";
import {
  decodeExecutionObject,
  encodeExecutionObject,
  encodeExecutionObjectEnvelope,
} from "../store/store-persistence.ts";
import type { StoredExecutionObject } from "../store/store.ts";

function executionObject(body: Json | Uint8Array): StoredExecutionObject {
  const canonical = body instanceof Uint8Array ? null : canonicalJson(body);
  return {
    objectId: "object",
    lifetimeScope: "execution",
    scopeOwnerId: "execution",
    objectKind: "test",
    body,
    contentHash: body instanceof Uint8Array ? sha256Bytes(body) : sha256(canonical!),
    byteLength:
      body instanceof Uint8Array
        ? body.byteLength
        : new TextEncoder().encode(canonical!).byteLength,
    createdAt: 1,
  };
}

it.each<Json>([
  null,
  [],
  { z: [true, null, -0, { '\"\\\n': '雪 😀 \",\"body\":null,\"x\":\"' }], a: 2 },
])("preserves canonical JSON envelope bytes and readback for %j", (body) => {
  const object = executionObject(body);
  const expected = new TextEncoder().encode(canonicalJson({ ...object, bodyKind: "json" }));
  expect(encodeExecutionObject(object)).toEqual(expected);
  expect(encodeExecutionObjectEnvelope(object)).toEqual(expected);
  expect(decodeExecutionObject(expected)).toEqual({
    ...object,
    body: JSON.parse(canonicalJson(body)),
  });
});

it("preserves exact binary envelope bytes and owns the encoded result", () => {
  const body = new Uint8Array([0, 255, 1, 128]);
  const object = executionObject(body);
  const encoded = encodeExecutionObject(object);
  expect(encoded).toEqual(
    new TextEncoder().encode(
      canonicalJson({
        ...object,
        bodyKind: "binary",
        body: "AP8BgA==",
      }),
    ),
  );
  expect(encodeExecutionObjectEnvelope(object)).toEqual(encoded);
  body.fill(0);
  expect(decodeExecutionObject(encoded).body).toEqual(new Uint8Array([0, 255, 1, 128]));
});

it("owns encoded JSON independently of later source mutation", () => {
  const body = { nested: { value: "original" } };
  const encoded = encodeExecutionObject(executionObject(body));
  body.nested.value = "mutated";
  expect(decodeExecutionObject(encoded).body).toEqual({ nested: { value: "original" } });
});

it("rejects inconsistent metadata and invalid JSON before encoding", () => {
  const object = executionObject({ ok: true });
  expect(() => encodeExecutionObject({ ...object, contentHash: "wrong" })).toThrow();
  expect(() => encodeExecutionObject({ ...object, byteLength: 0 })).toThrow();
  expect(() => encodeExecutionObject({ ...object, createdAt: NaN })).toThrow();
  expect(() => encodeExecutionObject({ ...object, body: { invalid: NaN } })).toThrow();
  const cyclic: Record<string, Json> = {};
  cyclic["self"] = cyclic;
  expect(() => encodeExecutionObject({ ...object, body: cyclic })).toThrow();
});
