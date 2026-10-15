import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "effection";
import { describeConversationStoreConformance } from "@sweatpants/history-store/conformance";
import { describeExecutionStoreConformance } from "@sweatpants/journal-authority/store-conformance";
import { durableKey } from "@sweatpants/durable-storage-kernel";
import { createD1DurableKernel, createD1Storage, initializeD1Storage } from "../index.ts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  controlValue,
  headValue,
  objectEnsure,
  checkpointEnsure,
  receiptClaim,
  publicEnsure,
} from "./fixtures/domain-records.ts";
let mf: Miniflare;
let db: D1Database;
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "journal",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: { JOURNAL: { type: "d1", id: "journal" } },
        },
      },
    ],
  });
  db = (await mf.getD1Database("JOURNAL")) as unknown as D1Database;
  await initializeD1Storage(db);
});
afterAll(async () => {
  await mf?.dispose();
});
async function fresh() {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sp_%' AND name <> 'sp_d1_meta'",
    )
    .all<{ name: string }>();
  await db.batch(tables.results.map(({ name }) => db.prepare(`DELETE FROM "${name}"`)));
  return createD1Storage(db);
}
describeConversationStoreConformance([
  {
    name: "d1",
    async create() {
      return { store: (await fresh()).conversationStore, close: async () => {} };
    },
  },
]);
describeExecutionStoreConformance([
  {
    name: "d1",
    async create() {
      return { store: (await fresh()).executionStore, close: async () => {} };
    },
  },
]);
describe("D1 atomic kernel", () => {
  it("rolls back retirement with publication and removes chunk rows only on success", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const old = objectEnsure("retire-large", "x".repeat(1_100_000));
    const key = durableKey("test");
    await run(() =>
      kernel.apply({
        ensures: [old],
        authority: {
          name: "control",
          collection: "execution-controls",
          key,
          expected: { revision: null, fence: "0" },
          next: { revision: "0", fence: "0", ...controlValue("test", "0") },
        },
      }),
    );
    expect(
      Number(await db.prepare("SELECT COUNT(*) AS count FROM sp_d1_payload_chunks").first("count")),
    ).toBeGreaterThan(0);
    const replacement = {
      ensures: [objectEnsure("retire-small", "small")],
      retireExecutionObjects: [old.key],
      authority: {
        name: "control",
        collection: "execution-controls" as const,
        key,
        expected: { revision: "0", fence: "0" },
        next: { revision: "1", fence: "0", ...controlValue("test", "1") },
      },
    };
    await db
      .prepare(
        "CREATE TRIGGER reject_retirement BEFORE DELETE ON sp_execution_objects BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END",
      )
      .run();
    await expect(run(() => kernel.apply(replacement))).rejects.toThrow(
      "injected retirement failure",
    );
    expect(await run(() => kernel.readImmutable("execution-objects", old.key))).not.toBeNull();
    expect(
      await run(() => kernel.readImmutable("execution-objects", durableKey("retire-small"))),
    ).toBeNull();
    expect((await run(() => kernel.readAuthority("execution-controls", key)))?.revision).toBe("0");
    await db.prepare("DROP TRIGGER reject_retirement").run();
    expect((await run(() => kernel.apply(replacement))).status).toBe("committed");
    expect(await run(() => kernel.readImmutable("execution-objects", old.key))).toBeNull();
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM sp_d1_payload_chunks").first("count"),
    ).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM sp_d1_payloads").first("count")).toBe(0);
  });

  it("replaces chunked and inline authority values without leaving stale payload rows", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const key = durableKey("inline-transition");
    const values = ["x".repeat(1024 * 1024 + 1), null, [0, 255, 128], "y".repeat(1024 * 1024 + 3)];
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      expect(
        (
          await run(() =>
            kernel.apply({
              ensures: [],
              authority: {
                name: "control",
                collection: "execution-controls",
                key,
                expected: { revision: index === 0 ? null : String(index - 1) },
                next: {
                  revision: String(index),
                  ...controlValue("inline-transition", String(index), "0", value),
                },
              },
            }),
          )
        ).status,
      ).toBe("committed");
      expect((await run(() => kernel.readAuthority("execution-controls", key)))?.value).toEqual(
        controlValue("inline-transition", String(index), "0", value).value,
      );
      const chunks = await db
        .prepare("SELECT COUNT(*) AS count FROM sp_d1_payload_chunks WHERE collection=? AND key=?")
        .bind("execution-controls", key)
        .first("count");
      if (typeof value === "string" && value.length > 1024 * 1024) {
        const parts = await db
          .prepare("SELECT parts FROM sp_d1_payloads WHERE collection=? AND key=?")
          .bind("execution-controls", key)
          .first("parts");
        expect(chunks).toBe(parts);
        expect(Number(chunks)).toBeGreaterThan(1);
      } else {
        expect(chunks).toBe(0);
        expect(
          await db
            .prepare("SELECT parts FROM sp_d1_payloads WHERE collection=? AND key=?")
            .bind("execution-controls", key)
            .first("parts"),
        ).toBeNull();
      }
    }
  });

  it("splits wide writes under D1's bound parameter limit without losing aliases", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const ensures = Array.from({ length: 40 }, (_, i) =>
      checkpointEnsure(`entry-${i}`, "wide", `alias-${i}`, i, `entry-${i}`),
    );
    expect((await run(() => kernel.apply({ ensures }))).status).toBe("committed");
    for (let i = 0; i < ensures.length; i++) {
      expect(
        (
          await run(() =>
            kernel.readImmutable("conversation-checkpoints", durableKey("wide", `alias-${i}`)),
          )
        )?.value,
      ).toEqual(ensures[i]!.value);
    }
  });

  it("atomically competes for an immutable alias without publishing losing side objects", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db, { maxAttempts: 1 });
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        run(() =>
          kernel.apply({
            ensures: [
              checkpointEnsure(`candidate-${i}`, "race", "shared-alias", i, "shared"),
              objectEnsure(`side-${i}`, i, "side"),
            ],
          }),
        ),
      ),
    );
    expect(outcomes.filter((value) => value.status === "committed")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "immutable_conflict")).toHaveLength(3);
    expect(
      (await db.prepare("SELECT object_id FROM sp_execution_objects").all()).results,
    ).toHaveLength(1);
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM sp_conversation_checkpoints").first("count"),
    ).toBe(1);
  });

  it("publishes one fenced optimistic batch and restores conflict details without leaking objects", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db, { maxAttempts: 1 });
    const key = durableKey("optimistic");
    await run(() =>
      kernel.apply({
        ensures: [],
        authority: {
          name: "control",
          collection: "execution-controls",
          key,
          expected: { revision: null, fence: "0" },
          next: { revision: "0", fence: "7", ...controlValue("optimistic", "0", "7", 0) },
        },
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        run(() =>
          kernel.apply({
            ensures: [objectEnsure(`optimistic-${i}`, i)],
            authority: {
              name: "control",
              collection: "execution-controls",
              key,
              expected: { revision: "0", fence: "7" },
              next: { revision: "1", fence: "7", ...controlValue("optimistic", "1", "7", i) },
            },
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "authority_conflict")).toHaveLength(3);
    const winner = await run(() => kernel.readAuthority("execution-controls", key));
    for (const result of results) {
      if (result.status === "authority_conflict") {
        expect(result.current).toEqual(winner);
      }
    }
    const rows = await db.prepare("SELECT object_id FROM sp_execution_objects").all();
    expect(rows.results).toHaveLength(1);
    const stale = await run(() =>
      kernel.apply({
        ensures: [],
        authority: {
          name: "control",
          collection: "execution-controls",
          key,
          expected: { revision: "1", fence: "6" },
          next: { revision: "2", fence: "7", ...controlValue("optimistic", "2", "7", 9) },
        },
      }),
    );
    expect(stale).toMatchObject({
      status: "authority_conflict",
      mismatch: "fence",
      current: winner,
    });
  });
  it("admits exactly one concurrent claimant and rolls back losing ensures", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(() =>
          kernel.apply({
            claim: receiptClaim("claim", "command"),
            ensures: [objectEnsure(String(i), i)],
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "claim_exists")).toHaveLength(7);
    const rows = await db.prepare("SELECT object_id FROM sp_execution_objects").all();
    expect(rows.results).toHaveLength(1);
  });
  it.each(["inline", "chunked"])(
    "rolls back the entire %s batch when a later database write fails",
    async (mode) => {
      await fresh();
      const kernel = createD1DurableKernel(db);
      await db
        .prepare(
          `CREATE TRIGGER fail_chunk BEFORE INSERT ON ${mode === "inline" ? "sp_conversation_heads" : "sp_d1_payload_chunks"} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
        )
        .run();
      const token = await db.prepare("SELECT token FROM sp_d1_meta").first("token");
      try {
        await expect(
          run(() =>
            kernel.apply({
              claim: receiptClaim("rollback", "command", "receipt"),
              ensures: [],
              authority: {
                name: "head",
                collection: "conversation-heads",
                key: durableKey("rollback"),
                expected: { revision: null },
                next: {
                  revision: "0",
                  ...headValue(
                    "rollback",
                    "0",
                    mode === "inline" ? null : "x".repeat(1024 * 1024 + 1),
                  ),
                },
              },
            }),
          ),
        ).rejects.toThrow("injected failure");
        expect(
          await db
            .prepare(
              "SELECT (SELECT COUNT(*) FROM sp_conversation_heads) + (SELECT COUNT(*) FROM sp_conversation_command_receipts) AS count",
            )
            .first("count"),
        ).toBe(0);
        expect(await db.prepare("SELECT token FROM sp_d1_meta").first("token")).toBe(token);
      } finally {
        await db.prepare("DROP TRIGGER fail_chunk").run();
      }
    },
  );
  it("fences concurrent authority writers without leaking the losing objects", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(() =>
          kernel.apply({
            ensures: [objectEnsure(String(i), i)],
            authority: {
              name: "control",
              collection: "execution-controls",
              key: durableKey("race"),
              expected: { revision: null },
              next: {
                revision: "0",
                fence: "9007199254740993",
                ...controlValue("race", "0", "9007199254740993", i),
              },
            },
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "authority_conflict")).toHaveLength(7);
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM sp_execution_objects").first("count"),
    ).toBe(1);
    expect(
      (await run(() => kernel.readAuthority("execution-controls", durableKey("race"))))?.fence,
    ).toBe("9007199254740993");
  });
  it("orders counters above Number precision and respects scan byte bounds", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const positions = ["9007199254740993", "9007199254740994", "10000000000000000"];
    for (const position of positions) {
      await run(() =>
        kernel.apply({
          ensures: [publicEnsure("scan", position)],
        }),
      );
    }
    const query = {
      collection: "conversation-public-segments" as const,
      index: "conversation-position" as const,
      scope: durableKey("scan"),
      direction: "forward" as const,
      after: null,
      maxRecords: 10,
      maxPayloadBytes:
        publicEnsure("scan", positions[0]!).value.encodedBytes +
        publicEnsure("scan", positions[1]!).value.encodedBytes,
    };
    const page = await run(() => kernel.scan(query));
    expect(page.records.map((r) => r.position)).toEqual(positions.slice(0, 2));
    expect(page.nextCursor).toBe(positions[1]);
    expect(
      (await run(() => kernel.scan({ ...query, after: page.nextCursor }))).records.map(
        (r) => r.position,
      ),
    ).toEqual(positions.slice(2));
  });
  it("resolves alternate identity races to the original immutable record", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const results = await Promise.all(
      ["first", "second"].map((key) =>
        run(() =>
          kernel.apply({
            ensures: [checkpointEnsure(key, "replay", "alias", 1, "object")],
          }),
        ),
      ),
    );
    expect(results.every((r) => r.status === "committed")).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM sp_conversation_checkpoints").first("count"),
    ).toBe(1);
  });
  it("roundtrips a record larger than D1's row limit", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const ensure = objectEnsure("large", "*".repeat(2_100_000), "large");
    await run(() => kernel.apply({ ensures: [ensure] }));
    const result = await run(() => kernel.readImmutable("execution-objects", ensure.key));
    expect(result?.value).toEqual(ensure.value);
  });
});

it("commits the maximum admitted ensure count with primary and alternate identities", async () => {
  await fresh();
  const kernel = createD1DurableKernel(db);
  const ensures = Array.from({ length: 256 }, (_, index) =>
    checkpointEnsure(`maximum-${index}`, "maximum", `cause-${index}`, index, `record-${index}`),
  );
  const outcome = await run(() => kernel.apply({ ensures }));
  expect(outcome.status).toBe("committed");
  if (outcome.status !== "committed") {
    throw new Error("Maximum bounded mutation was not committed");
  }
  expect(Object.keys(outcome.ensured)).toHaveLength(256);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM sp_conversation_checkpoints").first("count"),
  ).toBe(256);
  for (const index of [0, 127, 255]) {
    const record = await run(() =>
      kernel.readImmutable("conversation-checkpoints", durableKey("maximum", `cause-${index}`)),
    );
    expect(record?.value).toEqual(ensures[index]!.value);
  }
});

it("rejects counters outside signed 64-bit storage instead of silently clamping them", async () => {
  await fresh();
  const kernel = createD1DurableKernel(db);
  await expect(
    run(() =>
      kernel.apply({
        ensures: [],
        authority: {
          name: "control",
          collection: "execution-controls",
          key: durableKey("overflow"),
          expected: { revision: null, fence: "0" },
          next: {
            revision: "0",
            fence: "9223372036854775808",
            ...controlValue("overflow", "0", "9223372036854775808"),
          },
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "durable_kernel_integer_out_of_range" });
  expect(
    await run(() => kernel.readAuthority("execution-controls", durableKey("overflow"))),
  ).toBeNull();
});
