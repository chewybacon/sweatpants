// @vitest-environment node
import { createSqliteThreadMetadataStore } from "@/lib/sqlite-thread-metadata-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWriterBinding } from "@sweatpants/storage-sqlite/better-sqlite3";
import { configureThreadMetadataStore } from "@/lib/thread-metadata-store";

const roots: string[] = [];
const bindings: Array<{ close(): void }> = [];

afterEach(() => {
  for (const binding of bindings.splice(0).reverse()) {
    try {
      binding.close();
    } catch {
      // Teardown best effort.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The motivating defect: thread metadata used to live in an in-memory
 * singleton, so every server restart emptied the sidebar even though the
 * conversations survived in SQLite. As a co-tenant table on the same file,
 * a restart (new binding, same filename) preserves it.
 */
describe("durable thread metadata co-tenancy", () => {
  it("survives restarts with a new binding to the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "thread-restart-"));
    roots.push(root);
    const path = join(root, "yo-chat.sqlite");

    // Generation one: compose, create and rename threads.
    const first = createSqliteWriterBinding(path);
    bindings.push(first);
    configureThreadMetadataStore(createSqliteThreadMetadataStore(first));
    const store = createSqliteThreadMetadataStore(first);
    const alpha = store.create({ namespace: "threaded", title: "Flight planning" });
    const beta = store.create({ namespace: "threaded", title: "Tic tac toe" });
    store.update(alpha.id, { title: "Flight planning (renamed)", messageCount: 3 });
    store.delete(beta.id);

    // Generation two: a brand-new binding to the same filename — what a
    // server restart creates. Only the filename is shared.
    const second = createSqliteWriterBinding(path);
    bindings.push(second);
    expect(second).not.toBe(first);
    configureThreadMetadataStore(createSqliteThreadMetadataStore(second));

    const restarted = createSqliteThreadMetadataStore(second);
    const listed = restarted.list("threaded");
    expect(listed.map((thread) => thread.id)).toEqual([alpha.id]);
    expect(listed[0]).toMatchObject({
      id: alpha.id,
      title: "Flight planning (renamed)",
      messageCount: 3,
    });
    expect(restarted.get(beta.id)).toBeNull();

    // The renamed thread is still mutable after restart, and the write is
    // visible through the same store without constructing anything new.
    const updated = restarted.update(alpha.id, { messageCount: 5 });
    expect(updated?.messageCount).toBe(5);
    expect(restarted.get(alpha.id)?.messageCount).toBe(5);
  });
});
