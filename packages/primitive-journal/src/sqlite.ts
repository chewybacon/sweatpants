import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  encode,
  parseOutcome,
  type AcceptedExchange,
  type Attempt,
  type BeginAttempt,
  type Identity,
  type PendingJournal,
  type RequestOccurrence,
  type Json,
  type RetryMode,
  type Snapshot,
} from "./contract.ts";
import type { Outcome } from "./primitives.ts";

const digest = (entry: AcceptedExchange) =>
  createHash("sha256").update(encode(entry)).digest("hex");

/** Minimal local SQLite journal. The expected head checks protect commits, not external attempts. */
export class SqliteJournal implements PendingJournal {
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
        CREATE TABLE IF NOT EXISTS requests (
          execution_id TEXT NOT NULL REFERENCES executions(id), sequence INTEGER NOT NULL,
          request_id TEXT NOT NULL, request_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
          PRIMARY KEY(execution_id, sequence), UNIQUE(execution_id, request_id)
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
    const requests = this.#requests();
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
      const occurrence = requests.find((request) => request.sequence === sequence);
      if (occurrence && group.length > 0) {
        throw new Error("Mixed request/attempt provenance");
      }
      if (
        accepted &&
        !(
          (last?.status === "accepted" && encode(last.request) === encode(accepted.request)) ||
          (occurrence?.status === "accepted" &&
            encode(occurrence.request) === encode(accepted.request))
        )
      ) {
        throw new Error("Accepted entry has no matching accepted provenance");
      }
      if (!accepted && last?.status === "accepted") {
        throw new Error("Attempt accepted without an entry");
      }
    }
    for (const request of requests) {
      const entry = entries[request.sequence];
      if (request.status === "accepted") {
        if (!entry || encode(entry.request) !== encode(request.request)) {
          throw new Error("Request accepted without matching entry");
        }
      } else if (request.sequence !== entries.length || row.status !== "running") {
        throw new Error("Pending request must be the running head");
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
      return {
        identity: structuredClone(this.#identity),
        entries,
        attempts,
        status: "completed",
        value,
      };
    }
    if (row.status !== "running" || row.result_json !== null) {
      throw new Error("Invalid execution state");
    }
    return { identity: structuredClone(this.#identity), entries, attempts, status: "running" };
  }

  begin(sequence: number, request: Json, retryMode: RetryMode): BeginAttempt {
    const encoded = encode(request);
    return this.#transaction<BeginAttempt>(() => {
      const snapshot = this.read();
      if (snapshot.status !== "running" || snapshot.entries.length !== sequence) {
        throw new Error("Stale attempt head");
      }
      if (this.#requests().some((item) => item.sequence === sequence)) {
        throw new Error("External request excludes immediate attempts");
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
      if (this.#requests().some((request) => request.status === "pending")) {
        throw new Error("Unresolved request at completion");
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

  #requestId(sequence: number, request: Json): string {
    return createHash("sha256")
      .update(
        encode({
          domain: "primitive-journal.request.v1",
          identity: this.#identity,
          sequence,
          request,
        }),
      )
      .digest("hex");
  }

  #requests(): RequestOccurrence[] {
    return this.#database
      .prepare("SELECT * FROM requests WHERE execution_id = ? ORDER BY sequence")
      .all(this.#identity.executionId)
      .map((row): RequestOccurrence => {
        const sequence = Number(row.sequence);
        const request = JSON.parse(String(row.request_json)) as Json;
        if (
          !Number.isSafeInteger(sequence) ||
          sequence < 0 ||
          (row.status !== "pending" && row.status !== "accepted") ||
          row.request_id !== this.#requestId(sequence, request)
        ) {
          throw new Error("Invalid request occurrence");
        }
        return { id: String(row.request_id), sequence, request, status: row.status };
      });
  }

  readRequests(): readonly RequestOccurrence[] {
    this.read();
    return this.#requests();
  }

  park(sequence: number, request: Json): RequestOccurrence {
    const encoded = encode(request);
    return this.#transaction(() => {
      const snapshot = this.read();
      if (snapshot.status !== "running" || snapshot.entries.length !== sequence) {
        throw new Error("Stale request head");
      }
      if (snapshot.attempts.some((attempt) => attempt.sequence === sequence)) {
        throw new Error("Immediate attempt excludes external request");
      }
      const previous = this.#requests().find((item) => item.sequence === sequence);
      if (previous) {
        if (previous.status !== "pending" || encode(previous.request) !== encoded) {
          throw new Error("Pending request mismatch");
        }
        return previous;
      }
      this.#database
        .prepare("INSERT INTO requests VALUES (?, ?, ?, ?, 'pending')")
        .run(
          this.#identity.executionId,
          sequence,
          this.#requestId(sequence, JSON.parse(encoded) as Json),
          encoded,
        );
      return this.#requests().find((item) => item.sequence === sequence)!;
    });
  }

  acceptRequest(id: string, outcome: Outcome<Json, Json>): AcceptedExchange {
    const canonical = parseOutcome(JSON.parse(encode(outcome)));
    return this.#transaction(() => {
      const snapshot = this.read();
      const occurrence = this.#requests().find((item) => item.id === id);
      if (!occurrence) {
        throw new Error("Unknown request ID in this execution");
      }
      if (occurrence.status === "accepted") {
        const entry = snapshot.entries[occurrence.sequence]!;
        if (encode(entry.outcome) !== encode(canonical)) {
          throw new Error("Conflicting request answer");
        }
        return entry;
      }
      if (
        snapshot.status !== "running" ||
        occurrence.sequence !== snapshot.entries.length ||
        snapshot.attempts.some((attempt) => attempt.sequence === occurrence.sequence)
      ) {
        throw new Error("Stale request acceptance head");
      }
      const entry = {
        sequence: occurrence.sequence,
        request: occurrence.request,
        outcome: canonical,
      };
      this.#database
        .prepare("INSERT INTO exchanges VALUES (?, ?, ?, ?, ?)")
        .run(
          this.#identity.executionId,
          entry.sequence,
          encode(entry.request),
          encode(entry.outcome),
          digest(entry),
        );
      this.#database
        .prepare("UPDATE executions SET head = head + 1 WHERE id = ?")
        .run(this.#identity.executionId);
      this.#database
        .prepare(
          "UPDATE requests SET status = 'accepted' WHERE execution_id = ? AND request_id = ?",
        )
        .run(this.#identity.executionId, id);
      return this.read().entries[entry.sequence]!;
    });
  }

  #transaction<T>(action: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      // Validate the complete proposed state before publishing any mutation.
      this.read();
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
