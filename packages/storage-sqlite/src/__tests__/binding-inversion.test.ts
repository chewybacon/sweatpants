import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { run, type Operation } from "effection";
import { canonicalJson, sha256 } from "@sweatpants/foundation";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteReaderBinding,
  createSqliteWriterBinding,
  openBetterSqliteStorage,
  type BetterSqliteStorageHandle,
  type BetterSqliteStorageOptions,
} from "../better-sqlite3.ts";
import { DurableKernelError, SqliteBindingError } from "../contract.ts";

const roots: string[] = [];
const closables: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const closable of closables.splice(0).reverse()) {
    try {
      closable.close();
    } catch {
      // Teardown best effort; failures surface in the scenarios themselves.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function tempFile(name: string): string {
  return join(roots[roots.length - 1]!, name);
}

function track<T extends { close(): void }>(closable: T): T {
  closables.push(closable);
  return closable;
}

type OpenOutcome = { ok: true; handle: BetterSqliteStorageHandle } | { ok: false; error: unknown };

/** Opens inside one Effection scope, capturing failures as values. */
async function attemptOpen(
  path: string | undefined,
  options: BetterSqliteStorageOptions,
): Promise<OpenOutcome> {
  return run(function* () {
    try {
      const handle = yield* openBetterSqliteStorage(path, options);
      return { ok: true, handle } satisfies OpenOutcome;
    } catch (error) {
      return { ok: false, error } satisfies OpenOutcome;
    }
  });
}

/** Opens, runs the operation body while the handle is live, then closes. */
async function attemptUse(
  path: string | undefined,
  options: BetterSqliteStorageOptions,
  body: (handle: BetterSqliteStorageHandle) => Operation<void>,
): Promise<OpenOutcome> {
  return run(function* () {
    const handle = yield* openBetterSqliteStorage(path, options);
    try {
      yield* body(handle);
      return { ok: true, handle } satisfies OpenOutcome;
    } finally {
      yield* handle.close();
    }
  });
}

function putObjectBody(kind: string) {
  const body = { ok: true, kind };
  const snapshot = canonicalJson(body);
  const snapshotDigest = sha256(snapshot);
  return {
    objectId: `object-${kind}`,
    lifetimeScope: "execution" as const,
    scopeOwnerId: "execution-test",
    objectKind: "test",
    contentHash: snapshotDigest,
    byteLength: new TextEncoder().encode(snapshot).byteLength,
    body,
    createdAt: 1,
  };
}

describe("SQLite binding inversion", () => {
  it("applies kernel discipline to a handed-in binding, idempotently (TC-001)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("app.sqlite");
    const binding = track(createSqliteWriterBinding(path));

    const first = await attemptUse(
      undefined,
      { database: binding, initialize: true },
      function* (handle) {
        yield* handle.storage.executionStore.putObject(putObjectBody("discipline"));
      },
    );
    expect(first.ok).toBe(true);

    expect(binding.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(Number(binding.pragma("foreign_keys", { simple: true }))).toBe(1);
    expect(Number(binding.pragma("busy_timeout", { simple: true }))).toBeGreaterThanOrEqual(5000);
    expect(binding.open).toBe(true);
    const row = binding
      .prepare("SELECT content_hash FROM sp_execution_objects WHERE object_id = ?")
      .get("object-discipline") as { content_hash: string } | undefined;
    expect(row?.content_hash).toBe(putObjectBody("discipline").contentHash);

    // Second open over the same binding is a no-op, not an error.
    const second = await attemptUse(
      undefined,
      { database: binding, initialize: true },
      function* () {},
    );
    expect(second.ok).toBe(true);
    expect(binding.open).toBe(true);
  });

  it("rejects ambiguous and absent binding sources (TC-002)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("app.sqlite");

    const both = await attemptOpen(path, { database: track(new Database(":memory:")) });
    expect(both.ok).toBe(false);
    expect((both as { error: SqliteBindingError }).error).toBeInstanceOf(SqliteBindingError);
    expect((both as { error: SqliteBindingError }).error.code).toBe("binding_conflict");

    const neither = await attemptOpen(undefined, {});
    expect(neither.ok).toBe(false);
    expect((neither as { error: SqliteBindingError }).error.code).toBe("binding_conflict");
  });

  it("rejects readonly bindings without closing them (TC-003)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("app.sqlite");
    track(createSqliteWriterBinding(path)).close();

    const reader = track(createSqliteReaderBinding(path));
    const outcome = await attemptOpen(undefined, { database: reader, initialize: true });
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: SqliteBindingError }).error.code).toBe("binding_readonly");
    expect(reader.open).toBe(true);
  });

  it("closes only kernel-created bindings (TC-004)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("app.sqlite");
    const binding = track(createSqliteWriterBinding(path));

    // Path mode: the kernel closes what it created.
    const pathMode = await attemptOpen(path, { initialize: true });
    expect(pathMode.ok).toBe(true);
    if (pathMode.ok) {
      await pathMode.handle.close();
    }

    // Database mode: the kernel leaves the caller's binding open.
    const databaseMode = await attemptOpen(undefined, { database: binding, initialize: true });
    expect(databaseMode.ok).toBe(true);
    if (databaseMode.ok) {
      await databaseMode.handle.close();
    }
    expect(binding.open).toBe(true);
    const one = binding.prepare("SELECT 1 AS one").get() as { one: number | bigint };
    expect(Number(one.one)).toBe(1);
  });

  it("reconstructs authority data across generations sharing only the filename (TC-005)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("generations.sqlite");

    const first = await attemptUse(path, { initialize: true }, function* (handle) {
      yield* handle.storage.executionStore.putObject(putObjectBody("generation-one"));
    });
    expect(first.ok).toBe(true);

    const binding = track(createSqliteWriterBinding(path));
    const second = await attemptUse(
      undefined,
      { database: binding, initialize: true },
      function* (handle) {
        yield* handle.storage.executionStore.putObject(putObjectBody("generation-two"));
      },
    );
    expect(second.ok).toBe(true);
    expect(binding.open).toBe(true);

    const raw = track(new Database(path));
    const ids = raw
      .prepare("SELECT object_id FROM sp_execution_objects ORDER BY object_id")
      .all()
      .map((row) => (row as { object_id: string }).object_id);
    expect(ids).toEqual(["object-generation-one", "object-generation-two"]);
  });

  it("ignores co-tenant objects during open, initialization, and operation (TC-014)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("co-tenant.sqlite");
    const raw = track(new Database(path));
    raw.exec(`
      CREATE TABLE user_preferences (id text primary key, value text);
      CREATE INDEX idx_user_preferences_value ON user_preferences (value);
    `);
    raw.prepare("INSERT INTO user_preferences VALUES ('theme', 'dark')").run();

    const outcome = await attemptUse(path, { initialize: true }, function* (handle) {
      yield* handle.storage.executionStore.putObject(putObjectBody("co-tenant"));
    });
    expect(outcome.ok).toBe(true);

    const after = raw.prepare("SELECT value FROM user_preferences WHERE id = 'theme'").get();
    expect(after).toEqual({ value: "dark" });
  });

  it("fails closed on foreign sp_-prefixed objects of every type (TC-015)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const cases: Array<[string, string, string]> = [
      ["table", "CREATE TABLE sp_user_cache (id text)", "sp_user_cache"],
      ["view", "CREATE VIEW sp_user_view AS SELECT 1", "sp_user_view"],
      ["index", "CREATE TABLE plain (id text)", "sp_plain_idx"],
      [
        "trigger",
        `CREATE TABLE sp_trigger_base (id text);
         CREATE TRIGGER sp_trigger_guard AFTER INSERT ON sp_trigger_base BEGIN SELECT 1; END;`,
        "sp_trigger_guard",
      ],
    ];
    for (const [kind, ddl, objectName] of cases) {
      const path = tempFile(`collision-${kind}.sqlite`);
      const raw = track(new Database(path));
      raw.exec(ddl);
      if (kind === "index") {
        raw.exec("CREATE INDEX sp_plain_idx ON plain (id)");
      }

      const outcome = await attemptOpen(path, { initialize: true });
      expect(outcome.ok, kind).toBe(false);
      const error = (outcome as { error: SqliteBindingError }).error;
      expect(error, kind).toBeInstanceOf(SqliteBindingError);
      expect(error.code, kind).toBe("namespace_collision");
      expect(error.message, kind).toContain(objectName);

      const survives = raw
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE substr(name, 1, 3) = 'sp_'")
        .get() as { n: number };
      expect(survives.n, kind).toBeGreaterThan(0);
    }

    // Control: a kernel-only file opens cleanly.
    const clean = await attemptOpen(tempFile("clean.sqlite"), { initialize: true });
    expect(clean.ok).toBe(true);
  });

  it("waits on cross-connection writer contention instead of failing (TC-016)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("contention.sqlite");
    const coTenant = track(new Database(path));
    coTenant.pragma("busy_timeout = 0");

    // Control: with busy_timeout disabled, contention fails immediately.
    coTenant.exec("CREATE TABLE co_tenant_notes (id text primary key, note text)");
    coTenant.exec("BEGIN IMMEDIATE");
    const zero = new Database(path);
    zero.pragma("busy_timeout = 0");
    expect(() => zero.exec("BEGIN IMMEDIATE")).toThrow();
    coTenant.exec("COMMIT");
    zero.close();

    // Cross-thread contention: a child process holds BEGIN IMMEDIATE for a
    // moment while the kernel write waits on its busy_timeout. better-sqlite3
    // blocks the event loop while waiting, so an in-process holder could
    // never release the lock — the holder must live in another thread of
    // execution, exactly as the storage-inspector reader does.
    const require = createRequire(import.meta.url);
    const betterSqlite3Path = require.resolve("better-sqlite3");
    // Deterministic interleaving: the parent converts the fresh file to WAL
    // first (uncontended - SQLite's journal_mode conversion does not invoke
    // the busy handler, so converting under a co-tenant lock would fail
    // instantly), then the child acquires and announces the held write
    // transaction, and the kernel write below must wait on its busy_timeout
    // for the child's 250ms commit - the exact behavior under test.
    const binding = track(createSqliteWriterBinding(path));

    const holder = spawnProcess(
      process.execPath,
      [
        "-e",
        `const Database = require(process.argv[1]);
         const db = new Database(process.argv[2]);
         db.pragma("busy_timeout = 2000");
         db.exec("CREATE TABLE IF NOT EXISTS co_tenant_notes (id text primary key, note text)");
         db.exec("BEGIN IMMEDIATE");
         db.prepare("INSERT INTO co_tenant_notes VALUES ('held', 'by-child')").run();
         process.stdout.write("locked\\n");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 250);`,
        betterSqlite3Path,
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    await new Promise<void>((resolve, reject) => {
      holder.stdout.setEncoding("utf8");
      holder.stdout.once("data", (chunk: string) =>
        chunk.includes("locked")
          ? resolve()
          : reject(new Error(`unexpected child output: ${chunk}`)),
      );
      holder.once("exit", (code) => reject(new Error(`holder exited ${code} before locking`)));
    });

    const outcome = await attemptUse(
      undefined,
      { database: binding, initialize: true },
      function* (handle) {
        yield* handle.storage.executionStore.putObject(putObjectBody("contention"));
      },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
      );
    });
    expect(outcome.ok).toBe(true);

    const object = coTenant
      .prepare("SELECT content_hash FROM sp_execution_objects WHERE object_id = ?")
      .get("object-contention") as { content_hash: string } | undefined;
    expect(object?.content_hash).toBe(putObjectBody("contention").contentHash);
    const note = coTenant.prepare("SELECT note FROM co_tenant_notes WHERE id = 'held'").get() as
      | { note: string }
      | undefined;
    expect(note?.note).toBe("by-child");
  });

  it("refuses writes through reader bindings (TC-013)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("reader.sqlite");
    const setup = await attemptOpen(path, { initialize: true });
    expect(setup.ok).toBe(true);
    if (setup.ok) {
      await setup.handle.close();
    }

    const reader = track(createSqliteReaderBinding(path));
    expect(() => {
      reader.prepare("INSERT INTO sp_execution_objects (object_id) VALUES ('nope')").run();
    }).toThrow();

    const missing = await attemptOpen(tempFile("missing.sqlite"), { readonly: true });
    expect(missing.ok).toBe(false);
  });

  it("fails on a corrupt file with a named error (fail-closed preservation)", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("corrupt.sqlite");
    await writeFile(path, "this is not a sqlite file".repeat(10));
    const outcome = await attemptOpen(path, { initialize: true });
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: DurableKernelError }).error).toBeInstanceOf(DurableKernelError);
  });

  it("keeps generation state isolated between opens", async () => {
    roots.push(await mkdtemp(join(tmpdir(), "storage-binding-")));
    const path = tempFile("isolated.sqlite");
    await run(function* () {
      const first = yield* openBetterSqliteStorage(path, { initialize: true });
      const second = yield* openBetterSqliteStorage(path, { initialize: true });
      expect(first.database).not.toBe(second.database);
      expect(first.storage).not.toBe(second.storage);
      yield* first.close();
      yield* second.close();
    });
  });
});
