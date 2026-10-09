import { run } from "effection";
import { expect, it } from "vitest";
import { sha256 } from "@sweatpants/foundation";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";

it("round-trips a JSON null object without confusing it with a missing object", async () => {
  const handle = await run(() => openBetterSqliteStorage(":memory:", { initialize: true }));
  const object = {
    objectId: "json-null",
    lifetimeScope: "execution" as const,
    scopeOwnerId: "execution",
    objectKind: "result",
    contentHash: sha256("null"),
    byteLength: 4,
    body: null,
    createdAt: 1,
  };
  try {
    const pointer = await run(() => handle.storage.executionStore.putObject(object));
    expect(await run(() => handle.storage.executionStore.getObject(pointer))).toEqual(object);
    expect(
      await run(() => handle.storage.executionStore.getObject({ objectId: "missing" })),
    ).toBeNull();
  } finally {
    await run(() => handle.close());
  }
});
