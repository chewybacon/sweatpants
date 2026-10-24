import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  encode,
  parseOutcome,
  type AcceptedExchange,
  type Attempt,
  type BeginAttempt,
  type Identity,
  type Journal,
  type Json,
  type RetryMode,
  type Snapshot,
} from "./contract.ts";
import type { Outcome } from "./primitives.ts";

const digest = (entry: AcceptedExchange) =>
  createHash("sha256").update(encode(entry)).digest("hex");

/** Minimal local SQLite journal. The expected head checks protect commits, not external attempts. */
export class SqliteJournal implements Journal {
  readonly #database: DatabaseSync;
  readonly #identity: Identity;

  constructor(path: string, identity: Identity) {
    this.#identity = JSON.parse(encode(identity)) as Identity;
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS executions (
          id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed')), result_json TEXT
        );
        CREATE TABLE IF NOT EXISTS exchanges (
          execution_id TEXT NOT NULL REFERENCES executions(id), sequence INTEGER NOT NULL,
          request_json TEXT NOT NULL, outcome_json TEXT NOT NULL, digest TEXT NOT NULL,
          PRIMARY KEY(execution_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS attempts (
          execution_id TEXT NOT NULL REFERENCES executions(id), sequence INTEGER NOT NULL,
          number INTEGER NOT NULL, request_json TEXT NOT NULL,
          retry_mode TEXT NOT NULL CHECK(retry_mode IN ('repeatable','unsafe')),
          status TEXT NOT NULL CHECK(status IN ('started','unknown','accepted')),
          PRIMARY KEY(execution_id, sequence, number)
        );
      `);
      this.#database
        .prepare("INSERT OR IGNORE INTO executions(id, identity_json) VALUES (?, ?)")
        .run(identity.executionId, encode(identity));
      this.read();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  read(): Snapshot {
    const row = this.#database
      .prepare("SELECT * FROM executions WHERE id = ?")
      .get(this.#identity.executionId);
    if (!row || row.identity_json !== encode(this.#identity)) {
      throw new Error("Program/input identity mismatch");
    }
    const rows = this.#database
      .prepare("SELECT * FROM exchanges WHERE execution_id = ? ORDER BY sequence")
      .all(this.#identity.executionId);
    if (row.head !== rows.length) {
      throw new Error("Accepted history head mismatch");
    }
    const entries = rows.map((entry, sequence): AcceptedExchange => {
      if (entry.sequence !== sequence) {
        throw new Error("Noncontiguous accepted history");
      }
      const accepted = {
        sequence,
        request: JSON.parse(String(entry.request_json)) as Json,
        outcome: parseOutcome(JSON.parse(String(entry.outcome_json))),
      };
      if (entry.digest !== digest(accepted)) {
        throw new Error("Accepted entry integrity mismatch");
      }
      return accepted;
    });
    const attempts = this.#database
      .prepare("SELECT * FROM attempts WHERE execution_id = ? ORDER BY sequence, number")
      .all(this.#identity.executionId)
      .map((attempt): Attempt => {
        if (
          !Number.isSafeInteger(attempt.sequence) ||
          !Number.isSafeInteger(attempt.number) ||
          (attempt.retry_mode !== "repeatable" && attempt.retry_mode !== "unsafe") ||
          !["started", "unknown", "accepted"].includes(String(attempt.status))
        ) {
          throw new Error("Invalid attempt");
        }
        return {
          sequence: Number(attempt.sequence),
          number: Number(attempt.number),
          request: JSON.parse(String(attempt.request_json)) as Json,
          retryMode: attempt.retry_mode,
          status: attempt.status as Attempt["status"],
        };
      });
    for (const attempt of attempts) {
      if (attempt.sequence < 0 || attempt.sequence > entries.length || attempt.number < 0) {
        throw new Error("Invalid attempt position");
      }
    }
    for (let sequence = 0; sequence <= entries.length; sequence++) {
      const group = attempts.filter((attempt) => attempt.sequence === sequence);
      for (const [number, attempt] of group.entries()) {
        if (
          attempt.number !== number ||
          (number < group.length - 1 && attempt.status !== "unknown")
        ) {
          throw new Error("Invalid attempt history");
        }
        if (
          encode(attempt.request) !== encode(group[0]!.request) ||
          attempt.retryMode !== group[0]!.retryMode
        ) {
          throw new Error("Attempt identity changed");
        }
      }
      const accepted = entries[sequence];
      const last = group.at(-1);
      if (
        accepted &&
        (!last || last.status !== "accepted" || encode(last.request) !== encode(accepted.request))
      ) {
        throw new Error("Accepted entry has no matching accepted attempt");
      }
      if (!accepted && last?.status === "accepted") {
        throw new Error("Attempt accepted without an entry");
      }
    }
    if (row.status === "completed") {
      if (attempts.some((attempt) => attempt.sequence === entries.length)) {
        throw new Error("Terminal execution has a pending attempt");
      }
      if (typeof row.result_json !== "string") {
        throw new Error("Missing terminal result");
      }
      const value = JSON.parse(row.result_json) as Json;
      encode(value);
      return { identity: this.#identity, entries, attempts, status: "completed", value };
    }
    if (row.status !== "running" || row.result_json !== null) {
      throw new Error("Invalid execution state");
    }
    return { identity: this.#identity, entries, attempts, status: "running" };
  }

  begin(sequence: number, request: Json, retryMode: RetryMode): BeginAttempt {
    const encoded = encode(request);
    return this.#transaction<BeginAttempt>(() => {
      const snapshot = this.read();
      if (snapshot.status !== "running" || snapshot.entries.length !== sequence) {
        throw new Error("Stale attempt head");
      }
      const previous = snapshot.attempts.filter((attempt) => attempt.sequence === sequence).at(-1);
      if (previous && (encode(previous.request) !== encoded || previous.retryMode !== retryMode)) {
        throw new Error("Pending attempt request/policy mismatch");
      }
      if (previous) {
        this.#database
          .prepare(
            "UPDATE attempts SET status = 'unknown' WHERE execution_id = ? AND sequence = ? AND number = ?",
          )
          .run(this.#identity.executionId, sequence, previous.number);
        if (previous.retryMode === "unsafe") {
          return { kind: "uncertain", attempt: { ...previous, status: "unknown" } };
        }
      }
      const attempt: Attempt = {
        sequence,
        number: (previous?.number ?? -1) + 1,
        request: JSON.parse(encoded) as Json,
        retryMode,
        status: "started",
      };
      this.#database
        .prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, 'started')")
        .run(this.#identity.executionId, sequence, attempt.number, encoded, retryMode);
      return { kind: "started", attempt };
    });
  }

  accept(sequence: number, request: Json, outcome: Outcome<Json, Json>): AcceptedExchange {
    const entry: AcceptedExchange = JSON.parse(
      encode({ sequence, request, outcome: parseOutcome(outcome) }),
    );
    this.#transaction(() => {
      const snapshot = this.read();
      if (snapshot.status !== "running" || snapshot.entries.length !== sequence) {
        throw new Error("Stale acceptance head");
      }
      const attempt = snapshot.attempts.filter((item) => item.sequence === sequence).at(-1);
      if (
        !attempt ||
        attempt.status !== "started" ||
        encode(attempt.request) !== encode(entry.request)
      ) {
        throw new Error("Acceptance requires the current started attempt");
      }
      this.#database
        .prepare("INSERT INTO exchanges VALUES (?, ?, ?, ?, ?)")
        .run(
          this.#identity.executionId,
          sequence,
          encode(entry.request),
          encode(entry.outcome),
          digest(entry),
        );
      this.#database
        .prepare("UPDATE executions SET head = head + 1 WHERE id = ?")
        .run(this.#identity.executionId);
      this.#database
        .prepare(
          "UPDATE attempts SET status = 'accepted' WHERE execution_id = ? AND sequence = ? AND number = ?",
        )
        .run(this.#identity.executionId, sequence, attempt.number);
    });
    // Return the stored representation, rather than handing the unaccepted handler reply to the guest.
    const accepted = this.read().entries[sequence];
    if (!accepted) {
      throw new Error("Committed entry missing");
    }
    return accepted;
  }

  complete(sequence: number, value: Json): void {
    const encoded = encode(value);
    this.#transaction(() => {
      const snapshot = this.read();
      if (snapshot.entries.length !== sequence) {
        throw new Error("Terminal head mismatch");
      }
      if (snapshot.attempts.some((attempt) => attempt.sequence >= sequence)) {
        throw new Error("Unresolved attempt at completion");
      }
      if (snapshot.status === "completed") {
        if (encode(snapshot.value) !== encoded) {
          throw new Error("Terminal replay mismatch");
        }
        return;
      }
      this.#database
        .prepare("UPDATE executions SET status = 'completed', result_json = ? WHERE id = ?")
        .run(encoded, this.#identity.executionId);
    });
  }

  #transaction<T>(action: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
