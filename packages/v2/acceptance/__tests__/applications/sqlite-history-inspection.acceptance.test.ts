import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createSqliteHistoryReader } from "@sweatpan.ts/storage-sqlite/inspection";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

// ONI's inspector needs database-wide insertion order for model-round attribution,
// including settled child calls, while opening the file strictly read-only.
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: inspects ordered SQLite history through a read-only WAL snapshot`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "history-inspection-"));
    const file = join(directory, "journal.sqlite");
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL");
    let database: DatabaseSync | undefined;
    onTestFinished(() => {
      database?.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const connection = createNodeSqliteConnection(writer);
    const options = {
      connection,
      program: "inspector:v1",
      equals: isDeepStrictEqual,
      serialization: {
        *resolve() {
          return v8Serializer;
        },
      },
    };
    const first = createSqliteJournalStore<string, string, string, string>({
      ...options,
      id: "first",
    }).open();
    const second = createSqliteJournalStore<string, string, string, string>({
      ...options,
      id: "second",
    }).open();
    const task = runtime.start(function* () {
      function* append(journal: typeof first, request: string) {
        const state = yield* journal.read();
        const pending = yield* journal.park(state.revision, request);
        if (!pending) {
          throw new Error("Expected request");
        }
        return yield* journal.accept(pending.id, { ok: true, value: request });
      }
      const a = yield* append(first, "sample:first:0");
      const b = yield* append(second, "sample:second:0");
      database = new DatabaseSync(file, { readOnly: true });
      const reader = createSqliteHistoryReader({
        connection: createNodeSqliteConnection(database),
        serializer: v8Serializer,
      });
      database.exec("BEGIN");
      const page = reader.read({ limit: 1 });
      expect(page.map((entry) => [entry.tree, entry.execution, entry.accepted])).toEqual([
        ["first", "first", a.entry],
      ]);
      // Commit on a separate connection while the reader retains its earlier snapshot.
      const c = yield* append(first, "tool:first:0");
      const remaining = reader.read({ after: page[0]!.position, limit: 1 });
      expect(remaining.map((entry) => entry.accepted)).toEqual([b.entry]);
      expect(reader.read({ after: remaining[0]!.position, limit: 1 })).toEqual([]);
      database.exec("COMMIT");
      expect(reader.read({ after: remaining[0]!.position, limit: 1 })[0]?.accepted).toEqual(
        c.entry,
      );
      database.close();
      database = new DatabaseSync(file, { readOnly: true });
      const reopened = createSqliteHistoryReader({
        connection: createNodeSqliteConnection(database),
        serializer: v8Serializer,
      });
      expect(reopened.read({ limit: 10 }).map((entry) => entry.accepted)).toEqual([
        a.entry,
        b.entry,
        c.entry,
      ]);
      expect(() => reopened.read({ after: -1, limit: 1 })).toThrow("range");
      expect(() => reopened.read({ limit: 0 })).toThrow("range");
      const unsupported = createSqliteHistoryReader({
        connection: createNodeSqliteConnection(database),
        serializer: { ...v8Serializer, format: "other" },
      });
      expect(() => unsupported.read({ limit: 1 })).toThrow("serialization format");
      // Reads never appended a record or acquired journal advancement authority.
      const final = yield* first.read();
      expect(final.history.end).toEqual({ position: 2, receipt: c.entry.receipt });
    });
    onTestFinished(() => task.cancel());
    await task.result;
  });
});
