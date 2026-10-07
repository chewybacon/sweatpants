import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import { canonicalJson, sha256 } from "@sweatpants/foundation";
import { run } from "effection";
import { expect, it } from "vitest";
import { createKernelExecutionStore } from "../store/store-repository.ts";
import type { StoredExecutionObject } from "../store/store.ts";

function object(n: number): StoredExecutionObject {
  const body = { n };
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

it.each([1, 2])(
  "preserves immutable write arbitration when a competing writer stores n=%i",
  async (n) => {
    const kernel = createMemoryDurableKernel();
    const competitor = createKernelExecutionStore(kernel);
    let raced = false;
    const store = createKernelExecutionStore({
      ...kernel,
      *apply(mutation) {
        if (!raced) {
          raced = true;
          yield* competitor.putObject(object(n));
        }
        return yield* kernel.apply(mutation);
      },
    });
    const write = run(() => store.putObject(object(1)));
    if (n === 1) {
      await expect(write).resolves.toEqual({ objectId: "object" });
    } else {
      await expect(write).rejects.toMatchObject({ code: "immutable_object_conflict" });
    }
    expect(raced).toBe(true);
    expect(await run(() => store.getObject({ objectId: "object" }))).toEqual(object(n));
  },
);

it("rejects inconsistent content metadata before acknowledging a fresh write", async () => {
  const store = createKernelExecutionStore(createMemoryDurableKernel());
  await expect(run(() => store.putObject({ ...object(1), body: { n: 2 } }))).rejects.toThrow();
  expect(await run(() => store.getObject({ objectId: "object" }))).toBeNull();
});
