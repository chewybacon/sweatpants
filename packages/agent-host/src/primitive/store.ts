import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { encode } from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import type { Identity } from "@sweatpants/foundation/journal";
import type { Json } from "@sweatpants/foundation";
import type { TurnInput } from "./chat.ts";

export interface TurnRecord {
  conversation: string;
  ordinal: number;
  identity: Identity;
}
/** Admission/index only. All execution outcomes live in SqliteJournal. */
export class ChatStore {
  readonly database: DatabaseSync;
  constructor(
    readonly path: string,
    readonly program: Identity["program"],
  ) {
    this.database = new DatabaseSync(path);
    try {
      const tables = this.database
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all();
      if (tables.length && !tables.some((row) => row.name === "primitive_chat_schema")) {
        throw new Error("Unsupported database: primitive chat requires a fresh database");
      }
      this.database.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS primitive_chat_schema (version INTEGER PRIMARY KEY CHECK(version=1));
        INSERT OR IGNORE INTO primitive_chat_schema VALUES(1);
        CREATE TABLE IF NOT EXISTS chat_turns (execution TEXT PRIMARY KEY, conversation TEXT NOT NULL, ordinal INTEGER NOT NULL, identity_json TEXT NOT NULL, UNIQUE(conversation,ordinal));
        CREATE TABLE IF NOT EXISTS chat_commands (id TEXT PRIMARY KEY, execution TEXT NOT NULL, envelope TEXT NOT NULL, answer TEXT);
        CREATE TABLE IF NOT EXISTS chat_projection (execution TEXT PRIMARY KEY, projection TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_presentation (execution TEXT PRIMARY KEY, sample TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_revisions (conversation TEXT PRIMARY KEY, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL);
      `);
      for (const turn of this.turns()) {
        if (encode(turn.identity.program) !== encode(program)) {
          throw new Error("Program release mismatch");
        }
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  turns(conversation?: string): TurnRecord[] {
    const rows =
      conversation === undefined
        ? this.database.prepare("SELECT * FROM chat_turns ORDER BY rowid").all()
        : this.database
            .prepare("SELECT * FROM chat_turns WHERE conversation=? ORDER BY ordinal")
            .all(conversation);
    return rows.map((row) => ({
      conversation: String(row.conversation),
      ordinal: Number(row.ordinal),
      identity: JSON.parse(String(row.identity_json)) as Identity,
    }));
  }
  journal(turn: TurnRecord) {
    return new SqliteJournal(this.path, turn.identity);
  }
  command(id: string, envelope: Json): string | undefined {
    const row = this.database.prepare("SELECT * FROM chat_commands WHERE id=?").get(id);
    if (!row) {
      return undefined;
    }
    if (row.envelope !== encode(envelope)) {
      throw new Error("command_conflict");
    }
    return String(row.execution);
  }
  admit(conversation: string, input: TurnInput, commandId: string, envelope: Json): TurnRecord {
    const ordinal = this.turns(conversation).length;
    const identity: Identity = { executionId: randomUUID(), program: this.program, input };
    const existing = this.turns(conversation);
    if (
      input.messageId.startsWith(`${identity.executionId}:`) ||
      existing.some(
        (turn) =>
          input.messageId.startsWith(`${turn.identity.executionId}:`) ||
          (turn.identity.input as TurnInput).messageId.startsWith(`${identity.executionId}:`),
      )
    ) {
      throw new Error("message_id_conflict");
    }
    // Reserve all generated root/message IDs, even slots not yet published.
    // Check the candidate too: a user ID must not alias its own assistant/root.
    const ids = [...this.turns(conversation).map((turn) => turn.identity), identity].flatMap(
      (entry) => [
        (entry.input as TurnInput).messageId,
        `${entry.executionId}:initial`,
        `${entry.executionId}:final`,
        `${entry.executionId}:tool`,
      ],
    );
    if (new Set(ids).size !== ids.length) {
      throw new Error("message_id_conflict");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("INSERT INTO chat_turns VALUES(?,?,?,?)")
        .run(identity.executionId, conversation, ordinal, encode(identity));
      this.database
        .prepare("INSERT INTO chat_commands VALUES(?,?,?,NULL)")
        .run(commandId, identity.executionId, encode(envelope));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { conversation, ordinal, identity };
  }
  answer(execution: string, commandId: string, envelope: Json, id: string, value: Json) {
    this.database
      .prepare("INSERT INTO chat_commands VALUES(?,?,?,?)")
      .run(commandId, execution, encode(envelope), encode({ id, value }));
  }
  projection(execution: string): unknown {
    const row = this.database
      .prepare("SELECT projection FROM chat_projection WHERE execution=?")
      .get(execution);
    return row ? JSON.parse(String(row.projection)) : undefined;
  }
  sealProjection(execution: string, projection: Json) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("INSERT OR IGNORE INTO chat_projection VALUES(?,?)")
        .run(execution, encode(projection));
      this.database.prepare("DELETE FROM chat_presentation WHERE execution=?").run(execution);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  presentation(execution: string): unknown {
    const row = this.database
      .prepare("SELECT sample FROM chat_presentation WHERE execution=?")
      .get(execution);
    return row ? JSON.parse(String(row.sample)) : undefined;
  }
  publish(execution: string, sample: Json) {
    this.database
      .prepare(
        "INSERT INTO chat_presentation VALUES(?,?) ON CONFLICT(execution) DO UPDATE SET sample=excluded.sample",
      )
      .run(execution, encode(sample));
  }
  interrupt(execution: string, commandId: string, envelope: Json) {
    this.database
      .prepare("INSERT INTO chat_commands VALUES(?,?,?,NULL)")
      .run(commandId, execution, encode(envelope));
  }
  reconcileAnswers(turn: TurnRecord, journal: SqliteJournal) {
    for (const row of this.database
      .prepare("SELECT envelope FROM chat_commands WHERE execution=? ORDER BY rowid")
      .all(turn.identity.executionId)) {
      const envelope = JSON.parse(String(row.envelope)) as {
        command: { type: string; reason?: string };
      };
      if (envelope.command.type === "interrupt-turn") {
        journal.interrupt(envelope.command.reason ?? "interrupted");
      }
    }

    const rows = this.database
      .prepare(
        "SELECT answer FROM chat_commands WHERE execution=? AND answer IS NOT NULL ORDER BY rowid",
      )
      .all(turn.identity.executionId);
    for (const row of rows) {
      const answer = JSON.parse(String(row.answer)) as { id: string; value: Json };
      journal.acceptRequest(answer.id, { ok: true, value: answer.value });
    }
  }
  revision(conversation: string, fingerprint: string): string {
    const row = this.database
      .prepare("SELECT * FROM chat_revisions WHERE conversation=?")
      .get(conversation);
    if (row?.fingerprint === fingerprint) {
      return String(row.revision);
    }
    const revision = Number(row?.revision ?? 0) + 1;
    this.database
      .prepare(
        "INSERT INTO chat_revisions VALUES(?,?,?) ON CONFLICT(conversation) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint",
      )
      .run(conversation, revision, fingerprint);
    return String(revision);
  }
  close() {
    this.database.close();
  }
}
