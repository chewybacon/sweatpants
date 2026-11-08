import {
  codeRunSchema,
  answerSchema,
  questionSchema,
  SubmissionRejected,
  type Answer,
  type Question,
} from "./contracts.ts";
import { isDeepStrictEqual } from "node:util";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import type { DatabaseSync } from "node:sqlite";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatHistoryMessage, ChatLoopResult } from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";

import { program, flightProgram, codeProgram, legacyCodeProgram, bindTurn } from "./program.ts";
import type { TextSampling } from "./sampling.ts";
import { chooseFlight } from "./flight.ts";
import { selectionSchema, supportSchema } from "./elicit-support.ts";
import { selectToolSupport } from "@sweatpan.ts/tools";
import { z } from "zod";
import type { JournalReader, ChildLink } from "@sweatpan.ts/durable";
import { codeInput, codeResult, codeToolId, legacyCodeToolId } from "./code-contracts.ts";
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
  readonly mode?: "tools" | "code";
  readonly support?: z.infer<typeof supportSchema>[];
};

/** Application-local SQLite conversation policy: one active turn, explicit predecessor,
 * idempotent submission IDs. Caller authorizes conversation access and owns the DB.
 * Reservation and journal admission are separate durable steps; retry repairs the gap. */
export function createConversation<Y>(
  runtime: Runtime<Y>,
  db: DatabaseSync,
  conversation: string,
  sampling: TextSampling<Y>,
  changed: () => void,
  loadLuaModule?: () => Promise<WebAssembly.Module>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_turns (
    conversation TEXT NOT NULL, ordinal INTEGER NOT NULL, command TEXT NOT NULL,
    execution TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, previous TEXT, input BLOB NOT NULL, program TEXT NOT NULL,
    PRIMARY KEY (conversation, ordinal), UNIQUE (conversation, command)
  )`);
  // This projection grants no journal authority and is never fed back to the model.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_previews (
    execution TEXT PRIMARY KEY, text TEXT NOT NULL
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
      .prepare("SELECT program, input FROM chat_turns WHERE conversation = ? AND execution = ?")
      .get(conversation, execution);
    if (!owned) {
      throw new Error("Execution outside this conversation");
    }
    if (
      owned.program !== chatProgram &&
      owned.program !== flightProgram.id &&
      owned.program !== codeProgram.id &&
      owned.program !== legacyCodeProgram.id
    ) {
      throw new Error("Unavailable conversation program");
    }
    return createSqliteJournalStore<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>(
      {
        connection: createNodeSqliteConnection(db),
        id: execution,
        program: String(owned.program),
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
    if (
      row.prompt !== input.prompt ||
      row.previous !== input.after ||
      z
        .object({ mode: z.enum(["tools", "code"]).default("tools") })
        .parse(v8Serializer.decode(row.input)).mode !== (input.mode ?? "tools") ||
      !isDeepStrictEqual(
        z
          .object({ support: z.array(supportSchema).default([]) })
          .parse(v8Serializer.decode(row.input)).support,
        input.support ?? [],
      )
    ) {
      throw new SubmissionRejected("command-conflict");
    }
  }
  const api = {
    /** Reserve in a short synchronous transaction, then idempotently admit outside it.
     * Never hold a SQLite transaction across a native yield or journal operation. */
    *submit(input: ConversationSubmission) {
      input = {
        command: input.command,
        prompt: input.prompt,
        after: input.after,
        support: input.support,
        mode: input.mode,
      };
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
        const selections = selectToolSupport(
          [{ tool: chooseFlight, server: [] }],
          input.support ?? [],
        ).available;
        const encoded = v8Serializer.encode({
          history,
          prompt: input.prompt,
          support: input.support ?? [],
          selections,
          mode: input.mode ?? "tools",
        });
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
              program:
                input.mode === "code"
                  ? codeProgram.id
                  : selections.length
                    ? flightProgram.id
                    : chatProgram,
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
      const row = db
        .prepare("SELECT program, input FROM chat_turns WHERE conversation = ? AND execution = ?")
        .get(conversation, execution) as Pick<Turn, "program" | "input"> | undefined;
      if (!row) {
        throw new Error("Execution outside this conversation");
      }
      return bindTurn(
        runtime,
        journal(execution),
        {
          loadLuaModule,
          sampling: {
            *sample(request) {
              return yield* runtime.composition.scoped(function* () {
                const stream = yield* sampling.stream(request);
                while (true) {
                  const item = yield* stream.next();
                  if (item.done) {
                    return item.value;
                  }
                  db.prepare(
                    "INSERT INTO chat_previews VALUES (?, ?) ON CONFLICT(execution) DO UPDATE SET text = excluded.text",
                  ).run(execution, item.value);
                  changed();
                }
              });
            },
          },
        },
        row.program,
        v8Serializer.decode(row.input),
      );
    },
    *questions(execution: string) {
      const state = yield* journal(execution).read();
      if (!state.admission) {
        return [];
      }
      const selections = z
        .object({ selections: z.array(selectionSchema).default([]) })
        .parse(state.admission?.input).selections;
      const stream = yield* api.turn(execution).interactions();
      const questions: Question[] = [];
      while (true) {
        const item = yield* stream.next();
        if (item.done) {
          return questions;
        }
        const question = item.value;
        const kind = Object.entries(chooseFlight.elicits).find(
          ([, declaration]) => declaration.id === question.declaration.id,
        )?.[0];
        if (!kind || !selections[0]) {
          throw new Error("Unsupported flight question");
        }
        questions.push(
          questionSchema.parse({
            root: execution,
            execution: question.execution,
            parentExecution: question.parent?.execution,
            grant: question.grant,
            kind,
            input: question.input,
            selection: selections[0],
          }),
        );
      }
    },
    *codeRuns(execution: string) {
      const root = journal(execution);
      type Reader = JournalReader<unknown, unknown, unknown, unknown, unknown, Y>;
      const readers: { reader: Reader; input: unknown }[] = [{ reader: root, input: undefined }];
      const seen = new Set<string>();
      const runs: z.infer<typeof codeRunSchema>[] = [];
      while (readers.length) {
        const { reader, input: retainedInput } = readers.shift()!;
        if (seen.has(reader.id)) {
          continue;
        }
        seen.add(reader.id);
        const state = yield* reader.read();
        if (state.program === codeToolId || state.program === legacyCodeToolId) {
          const retained = codeInput.parse(retainedInput);
          runs.push({
            id: reader.id,
            source: retained.source,
            state: state.status,
            result: state.status === "completed" ? codeResult.parse(state.value) : undefined,
          });
        }
        // Full bounded-demo history, including settled child links; observation never advances.
        const children = new Map<string, ChildLink>();
        for (let from = 0; from < state.history.end.position; ) {
          const page = yield* state.history.read(from, 128);
          if (!page.length) {
            throw new Error("Incomplete retained code history");
          }
          from += page.length;
          for (const entry of page) {
            for (const link of yield* reader.readChildren(entry.receipt)) {
              children.set(link.childId, link);
            }
          }
        }
        if (state.status === "running") {
          for (const link of state.children ?? []) {
            children.set(link.childId, link);
          }
        }
        for (const link of children.values()) {
          readers.push({ reader: yield* reader.openChild(link.childId), input: link.input });
        }
      }
      return runs;
    },
    *answer(input: Answer) {
      const command = answerSchema.parse(input);
      const root = journal(command.root);
      const child = yield* root.openDescendantInteractions(command.execution);
      const request = yield* child.journal.interactions.request(command.grant);
      if (
        !request ||
        typeof request !== "object" ||
        !("effect" in request) ||
        request.effect !== chooseFlight.elicits[command.kind].id
      ) {
        throw new Error("Question kind does not match stored authority");
      }
      const receipt = yield* api
        .turn(command.root)
        .answer(command, { ok: true, value: command.value });
      return { receipt: receipt.entry.receipt, duplicate: receipt.duplicate };
    },
    preview(execution: string) {
      return (
        db.prepare("SELECT text FROM chat_previews WHERE execution = ?").get(execution) as
          | { text: string }
          | undefined
      )?.text;
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
  return api;
}
