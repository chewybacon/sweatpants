import { run } from "effection";
import { expect, it } from "vitest";
import { DurableCollections, durableKey } from "@sweatpants/durable-storage-kernel";
import { createSqliteDurableKernel } from "../sqlite-kernel.ts";

it("waits without hidden database queries or connections", async () => {
  let accesses = 0;
  const database = new Proxy(
    {},
    {
      get() {
        accesses++;
        throw new Error("A wait must not access the database");
      },
    },
  ) as Parameters<typeof createSqliteDurableKernel>[0]["database"];
  const kernel = createSqliteDurableKernel({
    database,
    transactionRunner: {
      *transaction() {
        throw new Error("A wait must not open a transaction");
      },
    },
  });
  await run(() =>
    kernel.waitForChange({
      collection: DurableCollections.conversationHeads,
      key: durableKey("conversation"),
      afterRevision: "0",
      timeoutMs: 30,
    }),
  );
  expect(accesses).toBe(0);
});
