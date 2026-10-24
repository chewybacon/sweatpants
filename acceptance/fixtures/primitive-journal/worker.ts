import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { run, type Operation } from "effection";
import {
  driveJournal,
  success,
  trace,
  type IterableOperation,
  type Handler,
  type Json,
  type Outcome,
  type Work,
} from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { record, sequence, type RecordRequest } from "@sweatpants/primitive-journal/example";

const [path, stop = "none", mode = "repeatable"] = process.argv.slice(2);
if (!path) {
  throw new Error("Expected database path");
}
type Yielded = Operation<unknown> extends IterableOperation<unknown, infer Y> ? Y : never;
const journal = new SqliteJournal(path, {
  executionId: "sequence",
  program: { id: "sequence", version: "1", digest: "c".repeat(64) },
  input: "hello",
});
const handler: Handler<RecordRequest, Yielded, Outcome<Json, Json>> = function* (request) {
  const ledger = `${path}.calls.jsonl`;
  const count = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").length : 0;
  const value = `hello:recorded:${count + 1}`;
  appendFileSync(
    ledger,
    `${JSON.stringify({ occurrence: count, key: request.key, input: "hello", value })}\n`,
  );
  if (stop === "effect") {
    process.exit(74);
  }
  return success(value);
};
const work: Work<string, RecordRequest> =
  mode === "unsafe"
    ? function* () {
        return yield* record("same", "unsafe");
      }
    : sequence;
try {
  const result = await run(() =>
    driveJournal(
      work,
      journal,
      handler,
      [
        trace((event, value) => {
          appendFileSync(`${path}.middleware.jsonl`, `${JSON.stringify({ event, value })}\n`);
        }),
      ],
      (entry) => {
        writeFileSync(`${path}.prefix.json`, JSON.stringify(journal.read()));
        if (String(entry.sequence) === stop) {
          process.exit(73);
        }
      },
    ),
  );
  writeFileSync(`${path}.report.json`, JSON.stringify({ result, snapshot: journal.read() }));
} finally {
  journal.close();
}
