import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import { run } from "effection";
import { expect, it } from "vitest";
import { createTextExecutionObject } from "../store/store-persistence.ts";
import { createKernelExecutionStore } from "../store/store-repository.ts";

it("retains a bounded working set of immutable reads without retaining misses or caller mutations", async () => {
  const kernel = createMemoryDurableKernel();
  let reads = 0;
  const store = createKernelExecutionStore({
    ...kernel,
    *readImmutable(collection, key) {
      reads++;
      return yield* kernel.readImmutable(collection, key);
    },
  });
  const objects = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      createTextExecutionObject(
        {
          objectId: String(index),
          lifetimeScope: "execution",
          scopeOwnerId: "execution",
          objectKind: "test",
          createdAt: 1,
        },
        `body-${index}`,
      ),
    ),
  );
  await run(function* () {
    expect(yield* store.getObject({ objectId: "0" })).toBeNull();
    for (const object of objects) yield* store.putObject(object);
    const original = yield* store.getObject({ objectId: "0" });
    Object.assign(original!, { body: "caller mutation" });
    for (let index = 1; index < 4; index++) yield* store.getObject({ objectId: String(index) });
    const warmReads = reads;
    expect((yield* store.getObject({ objectId: "0" }))?.body).toBe("body-0");
    expect(reads).toBe(warmReads);
    yield* store.getObject({ objectId: "4" });
    const afterEviction = reads;
    expect((yield* store.getObject({ objectId: "0" }))?.body).toBe("body-0");
    expect(reads).toBe(afterEviction + 1);
    const reopened = createKernelExecutionStore(kernel);
    expect(yield* reopened.getObject({ objectId: "0" })).toEqual(objects[0]);
  });
});
