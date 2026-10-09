import { canonicalJson, sha256 } from "@sweatpants/foundation";
import { run } from "effection";
import { expect, it } from "vitest";
import { openPostgresStorage } from "../pg-binding.ts";
import { spExecutionControl } from "../schema.ts";

it("stores structured payloads as JSONB and preserves counters beyond JavaScript number precision", async () => {
  const handle = await openPostgresStorage({
    connectionString:
      process.env.SWEATPANTS_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:55432/sweatpants_test",
    initialize: true,
  });
  const payload = { nested: { text: "選択 🃏", values: [true, null, 3] } };
  const executionId = `structured-${Date.now()}`;
  try {
    await handle.database.insert(spExecutionControl).values({
      executionId,
      controlRevision: "9007199254740993",
      ownerFence: "9007199254740995",
      status: "parked",
      rootTaskId: "root",
      stopGeneration: "0",
      requestedDisposition: null,
      controlJson: payload,

      updatedAt: 1,
    });
    const loaded = await run(() => handle.storage.executionStore.loadControl(executionId));
    expect(loaded).toMatchObject({
      controlRevision: "9007199254740993",
      ownerFence: "9007199254740995",
      control: payload,
    });
    const result = await handle.pool.query(
      "SELECT pg_typeof(control_json)::text AS type, control_json #>> '{nested,text}' AS text FROM sp_execution_control WHERE execution_id = $1",
      [executionId],
    );
    expect(result.rows).toEqual([{ type: "jsonb", text: "選択 🃏" }]);
    const object = {
      objectId: `${executionId}-null`,
      lifetimeScope: "execution" as const,
      scopeOwnerId: executionId,
      objectKind: "result",
      contentHash: sha256("null"),
      byteLength: 4,
      body: null,
      createdAt: 1,
    };
    const pointer = await run(() => handle.storage.executionStore.putObject(object));
    expect(await run(() => handle.storage.executionStore.getObject(pointer))).toEqual(object);
    const binaryColumns = await handle.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sp_execution_objects' AND data_type = 'bytea'",
    );
    expect(binaryColumns.rows).toEqual([]);
  } finally {
    await run(() => handle.close());
  }
});

it("preserves JSON scalar values after node-postgres decodes JSONB", async () => {
  const handle = await openPostgresStorage({
    connectionString:
      process.env.SWEATPANTS_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:55432/sweatpants_test",
    initialize: true,
  });
  try {
    const bodies = [
      '{"nested":{"state":"parked"}}',
      "[1,true,null]",
      "42",
      "true",
      "null",
      '"quoted"',
      "ordinary text",
      42,
      true,
      null,
    ];
    for (const [index, body] of bodies.entries()) {
      const encoded = canonicalJson(body);
      const object = {
        objectId: `scalar-${index}`,
        lifetimeScope: "execution" as const,
        scopeOwnerId: "scalar-roundtrip",
        objectKind: "result",
        contentHash: sha256(encoded),
        byteLength: new TextEncoder().encode(encoded).byteLength,
        body,
        createdAt: 1,
      };
      const pointer = await run(() => handle.storage.executionStore.putObject(object));
      expect(await run(() => handle.storage.executionStore.getObject(pointer))).toEqual(object);
    }
  } finally {
    await run(() => handle.close());
  }
});
