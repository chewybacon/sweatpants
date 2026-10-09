import { canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { expect, it } from "vitest";
import { readExecutionObject, prepareExecutionObject } from "../store/store-persistence.ts";
import type { StoredExecutionObject } from "../store/store.ts";

function executionObject(body: Json): StoredExecutionObject {
  const canonical = canonicalJson(body);
  return {
    objectId: "object",
    lifetimeScope: "execution",
    scopeOwnerId: "execution",
    objectKind: "test",
    body,
    contentHash: sha256(canonical),
    byteLength: new TextEncoder().encode(canonical).byteLength,
    createdAt: 1,
  };
}

it.each<Json>([
  null,
  [],
  { z: [true, null, -0, { '\"\\\n': '雪 😀 \",\"body\":null,\"x\":\"' }], a: 2 },
])("passes structured records without changing body integrity for %j", async (body) => {
  const object = executionObject(body);
  const encoded = prepareExecutionObject(object);
  expect(encoded).toBe(object);
  expect(await readExecutionObject(encoded)).toEqual(object);
});

it("rejects payloads changed after preparation instead of caching stale encodings", async () => {
  const body = { nested: { value: "original" } };
  const prepared = prepareExecutionObject(executionObject(body));
  body.nested.value = "mutated";
  await expect(readExecutionObject(prepared)).rejects.toThrow(/content metadata/);
});

it("rejects inconsistent metadata and invalid JSON before persistence", () => {
  const object = executionObject({ ok: true });
  expect(() => prepareExecutionObject({ ...object, contentHash: "wrong" })).toThrow();
  expect(() => prepareExecutionObject({ ...object, byteLength: 0 })).toThrow();
  expect(() => prepareExecutionObject({ ...object, createdAt: NaN })).toThrow();
  expect(() => prepareExecutionObject({ ...object, body: { invalid: NaN } })).toThrow();
  const cyclic: Record<string, Json> = {};
  cyclic["self"] = cyclic;
  expect(() => prepareExecutionObject({ ...object, body: cyclic })).toThrow();
});
