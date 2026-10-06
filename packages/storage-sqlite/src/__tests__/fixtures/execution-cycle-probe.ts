import { privateToRow } from "@sweatpants/journal-authority/sql-codec";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { run } from "effection";
import { canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import { openBetterSqliteStorage } from "../../better-sqlite3.ts";

const databasePath = resolve(process.argv[2] ?? "");
if (!databasePath) {
  throw new Error("execution-cycle-probe requires a database path");
}

const handle = await run(() =>
  openBetterSqliteStorage(databasePath, { initialize: true, wal: false }),
);
try {
  const entries = [{ effect: "cycle" }];
  const encoded = canonicalSnapshot(entries);
  const segment = {
    segmentId: "cycle-journal",
    executionId: "cycle-execution",
    taskId: "cycle-task",
    previous: null,
    firstSequence: "0",
    lastSequence: "0",
    entries,
    contentHash: sha256(encoded.canonical),
    encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
    createdAt: 1,
  } as const;
  const pointer = await run(() => handle.storage.executionStore.appendJournalSegment(segment));

  // Intentional persisted-data corruption: a previous pointer cycle is a
  // fault-injection input, not a success-path fixture row.
  const cycle = privateToRow({
    ...segment,
    previous: { segmentId: segment.segmentId, lastSequence: "0" },
  });
  handle.database.run(
    sql`UPDATE sp_execution_journal_segments
        SET previous_segment_id = ${segment.segmentId}, stored_bytes = ${cycle.storedBytes}
        WHERE segment_id = ${segment.segmentId}`,
  );

  const stream = await run(() =>
    handle.storage.executionStore.readJournal({
      executionId: segment.executionId,
      taskId: segment.taskId,
      head: pointer,
    }),
  );
  try {
    for await (const _entries of stream) {
      // A cyclic chain must never yield a successful result.
    }
    process.stdout.write(JSON.stringify({ status: "completed" }) + "\n");
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "error",
        code: error instanceof Error && "code" in error ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 0;
  }
} finally {
  await run(() => handle.close());
}
