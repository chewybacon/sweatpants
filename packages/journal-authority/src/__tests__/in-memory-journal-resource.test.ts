import { run, spawn, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import {
  createInMemoryJournal,
  createCapabilityKeyring,
  installJournal,
  JournalAuthorityPort,
  type Journal,
} from "../index.ts";

const options = {
  journalId: "memory-resource",
  keyring: createCapabilityKeyring("memory-resource", [
    { keyId: "test", secret: "memory-resource-test-secret-32-bytes" },
  ]),
};
const command = {
  type: "execution.open-task" as const,
  request: {
    sessionId: "session",
    taskId: "root",
    turnId: "turn",
    manifest: {
      programId: "memory-resource",
      version: "1",
      digest: "a".repeat(64),
      inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: true,
        structuredChildren: false,
        replay: "strict" as const,
      },
    },
    input: { message: "original" },
    executionEpoch: 1,
    attachmentId: "attachment",
    audience: "workflow-host",
  },
};

describe("in-memory journal resource", () => {
  it("shares one resource through helpers and the installed authority port", async () => {
    function* acquire(): Operation<Journal> {
      return yield* createInMemoryJournal(options);
    }
    await run(function* () {
      const journal = yield* acquire();
      yield* installJournal(journal);
      const child = yield* spawn(function* () {
        return yield* JournalAuthorityPort.api.operations.command(command);
      });
      yield* child;
      expect((yield* journal.readSession("session")).map((record) => record.payload.type)).toEqual([
        "TaskOpened",
      ]);
      const snapshot = yield* journal.exportSnapshot();
      const restored = yield* createInMemoryJournal({ ...options, snapshot });
      expect(yield* restored.exportSnapshot()).toEqual(snapshot);
    });
  });

  it("ends every capability with the owner rather than leaving a mutable object alive", async () => {
    const escaped = await run(function* () {
      const journal = yield* createInMemoryJournal(options);
      yield* journal.advance(command);
      return journal;
    });
    await expect(run(() => escaped.advance(command))).rejects.toThrow("owning scope has exited");
    await expect(run(() => escaped.readSession("session"))).rejects.toThrow(
      "owning scope has exited",
    );
    await expect(run(() => escaped.exportSnapshot())).rejects.toThrow("owning scope has exited");
  });
});
