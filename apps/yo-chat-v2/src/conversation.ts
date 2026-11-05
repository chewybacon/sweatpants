import { SubmissionRejected } from "./contracts.ts";
import { isDeepStrictEqual } from "node:util";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import type { DatabaseSync } from "node:sqlite";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatHistoryMessage, ChatLoopResult } from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";

import { program, bindTurn, type Dependencies } from "./program.ts";
const chatProgram = program.id;

type Turn = {
  execution: string;
  program: string;
  ordinal: number;
  command: string;
  prompt: string;
  previous: string | null;
  input: Uint8Array;
};
export type ConversationSubmission = {
  readonly command: string;
  readonly prompt: string;
  readonly after: string | null;
};

/** Application-local SQLite conversation policy: one active turn, explicit predecessor,
 * idempotent submission IDs. Caller authorizes conversation access and owns the DB.
 * Reservation and journal admission are separate durable steps; retry repairs the gap. */
export function createConversation<Y>(
  runtime: Runtime<Y>,
  db: DatabaseSync,
  conversation: string,
  dependencies: Dependencies<Y>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_turns (
    conversation TEXT NOT NULL, ordinal INTEGER NOT NULL, command TEXT NOT NULL,
    execution TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, previous TEXT, input BLOB NOT NULL, program TEXT NOT NULL,
    PRIMARY KEY (conversation, ordinal), UNIQUE (conversation, command)
  )`);
  function command(id: string) {
    return db
      .prepare("SELECT * FROM chat_turns WHERE conversation = ? AND command = ?")
      .get(conversation, id) as Turn | undefined;
  }
  function latest() {
    return db
      .prepare("SELECT * FROM chat_turns WHERE conversation = ? ORDER BY ordinal DESC LIMIT 1")
      .get(conversation) as Turn | undefined;
  }
  function journal(execution: string) {
    const owned = db
      .prepare("SELECT program FROM chat_turns WHERE conversation = ? AND execution = ?")
      .get(conversation, execution);
    if (!owned) {
      throw new Error("Execution outside this conversation");
    }
    if (owned.program !== chatProgram) {
      throw new Error("Unavailable conversation program");
    }
    return createSqliteJournalStore<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>(
      {
        connection: createNodeSqliteConnection(db),
        id: execution,
        program: chatProgram,
        equals: isDeepStrictEqual,
        serialization: {
          *resolve() {
            return v8Serializer;
          },
        },
      },
    ).open();
  }
  function sameSubmission(row: Turn, input: ConversationSubmission) {
    if (row.prompt !== input.prompt || row.previous !== input.after) {
      throw new SubmissionRejected("command-conflict");
    }
  }
  return {
    /** Reserve in a short synchronous transaction, then idempotently admit outside it.
     * Never hold a SQLite transaction across a native yield or journal operation. */
    *submit(input: ConversationSubmission) {
      input = { command: input.command, prompt: input.prompt, after: input.after };
      if (!input.command.trim() || !input.prompt.trim()) {
        throw new Error("Empty conversation submission");
      }
      let row = command(input.command);
      let duplicate = Boolean(row);
      if (row) {
        sameSubmission(row, input);
      } else {
        const previous = latest();
        if ((previous?.execution ?? null) !== input.after) {
          throw new SubmissionRejected("stale-predecessor");
        }
        let history: readonly ChatHistoryMessage[] = [];
        if (previous) {
          const state = yield* journal(previous.execution).read();
          if (state.status !== "completed") {
            throw new SubmissionRejected("predecessor-incomplete");
          }
          history = state.value.history;
        }
        const encoded = v8Serializer.encode({ history, prompt: input.prompt });
        // Another submit may have advanced the catalog while reading the predecessor.
        db.exec("BEGIN IMMEDIATE");
        try {
          row = command(input.command);
          if (row) {
            sameSubmission(row, input);
            duplicate = true;
          } else {
            if ((latest()?.execution ?? null) !== input.after) {
              throw new SubmissionRejected("stale-predecessor");
            }
            row = {
              execution: JSON.stringify([conversation, input.command]),
              program: chatProgram,
              ordinal: (previous?.ordinal ?? 0) + 1,
              command: input.command,
              prompt: input.prompt,
              previous: input.after,
              input: encoded,
            };
            db.prepare("INSERT INTO chat_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
              conversation,
              row.ordinal,
              row.command,
              row.execution,
              row.prompt,
              row.previous,
              encoded,
              row.program,
            );
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      // Retry repairs admission after a reservation survived a lost request.
      yield* journal(row.execution).admit(row.program, v8Serializer.decode(row.input));
      return { execution: row.execution, ordinal: row.ordinal, duplicate };
    },
    /** Bind only a root enrolled in this conversation; descendant answers use its own authority. */
    turn(execution: string) {
      return bindTurn(runtime, journal(execution), dependencies);
    },
    /** Retained sequence, not a cached execution-status projection. */
    turns() {
      return db
        .prepare(
          "SELECT execution, ordinal, command, prompt FROM chat_turns WHERE conversation = ? ORDER BY ordinal",
        )
        .all(conversation) as Pick<Turn, "execution" | "ordinal" | "command" | "prompt">[];
    },
    read(execution: string) {
      return journal(execution).read();
    },
  };
}
