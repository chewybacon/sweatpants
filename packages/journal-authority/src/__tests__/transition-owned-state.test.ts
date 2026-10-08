import { createSignal, run, spawn, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import type {
  AuthorityCommand,
  CommandResult,
  JournalAuthorityContract,
} from "../contract/authority-contract.ts";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { createJournal } from "../shell/journal.ts";
import {
  adaptAuthorityPortsForConformance,
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "../testing/conformance.ts";

// The retained transition must agree with what a new host reconstructs from
// durable bytes, including while pulls are pending and after cancellation.
const store = createMemoryExecutionStore();
const factory: JournalAuthorityConformanceFactory = {
  backendName: "transition-owned-state",
  *open(options) {
    const warm = yield* createJournal(store, options);
    const authority: JournalAuthorityContract = {
      query: warm.query,
      *command<C extends AuthorityCommand>(command: C): Operation<CommandResult<C>> {
        const result = yield* warm.advance(command);
        const snapshot = yield* warm.exportSnapshot();
        const cold = yield* createJournal(store, options);
        // oxlint-disable-next-line vitest/no-standalone-expect -- Runs inside each conformance test's command operation.
        expect(yield* cold.exportSnapshot()).toEqual(snapshot);
        // Returned descriptors/outcomes belong to the caller, not the retained
        // transition. Preserve the value for the conformance scenario itself.
        const returned = structuredClone(result);
        if (result && typeof result === "object") {
          if (
            "descriptor" in result &&
            result.descriptor &&
            typeof result.descriptor === "object"
          ) {
            Reflect.set(result.descriptor, "type", "caller-edited");
          }
          if ("outcome" in result && result.outcome && typeof result.outcome === "object") {
            Reflect.set(result.outcome, "value", "caller-edited");
          }
        }
        // oxlint-disable-next-line vitest/no-standalone-expect -- Runs inside each conformance test's command operation.
        expect(yield* warm.exportSnapshot()).toEqual(snapshot);
        return returned;
      },
    };
    return adaptAuthorityPortsForConformance(authority, warm, {
      id: options.journalId,
      incarnation: "1",
    });
  },
};

describe("retained transition and cold restoration agree", () => {
  for (const scenario of createJournalAuthorityConformanceCases(factory)) {
    it(scenario.name, async () => {
      await run(() => scenario.run());
    });
  }

  it("captures command input before storage yields to another caller", async () => {
    const store = createMemoryExecutionStore();
    const loading = createSignal<void>();
    const resume = createSignal<void>();
    const options = {
      journalId: "capture-before-yield",
      keyring: createCapabilityKeyring("test", [
        { keyId: "test", secret: "transition-state-test-secret-32-bytes" },
      ]),
    };
    const input = { value: "original" };
    await run(function* () {
      const loaded = yield* loading;
      const resumed = yield* resume;
      let pause = true;
      const drivers = yield* createJournal(
        {
          ...store,
          *loadControl(id) {
            if (pause) {
              pause = false;
              loading.send();
              yield* resumed.next();
            }
            return yield* store.loadControl(id);
          },
        },
        options,
      );
      const writer = yield* spawn(function* () {
        yield* drivers.advance({
          type: "execution.open-task",
          request: {
            sessionId: "session",
            taskId: "root",
            turnId: "turn",
            manifest: {
              programId: "capture-before-yield",
              version: "1",
              digest: "a".repeat(64),
              inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
              outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
              elicits: {},
              effects: {},
              capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
            },
            input,
            executionEpoch: 1,
            attachmentId: "attachment",
            audience: "workflow-host",
          },
        });
      });
      yield* loaded.next();
      input.value = "changed while storage waits";
      resume.send();
      yield* writer;
      expect(
        yield* drivers.query({
          type: "task.input",
          sessionId: "session",
          taskId: "root",
        }),
      ).toEqual({ value: "original" });
      const cold = yield* createJournal(store, options);
      expect(yield* drivers.exportSnapshot()).toEqual(yield* cold.exportSnapshot());
    });
  });

  it("compacts sequential roots without losing historical records or leaking returned state", async () => {
    const store = createMemoryExecutionStore();
    const options = {
      journalId: "transition-owned-compaction",
      now: () => 1000,
      keyring: createCapabilityKeyring("test", [
        { keyId: "test", secret: "transition-state-test-secret-32-bytes" },
      ]),
    };
    await run(function* () {
      const warm = yield* createJournal(store, options);

      for (let turn = 0; turn < 3; turn++) {
        const input = { nested: { original: turn, zero: -0 } };
        const inputSchema = structuredClone(ANY_JSON_SCHEMA_DESCRIPTOR);
        Reflect.set(inputSchema.fidelity, "extra", "not part of the descriptor identity");
        const taskId = `root-${turn}`;
        const opened = yield* warm.advance({
          type: "execution.open-task",
          request: {
            sessionId: "session",
            taskId,
            turnId: `turn-${turn}`,
            manifest: {
              programId: "transition-owned",
              version: "1",
              digest: "a".repeat(64),
              inputSchema,
              outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
              elicits: {},
              effects: {},
              capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
            },
            input,
            executionEpoch: 1,
            attachmentId: `attachment-${turn}`,
            audience: "workflow-host",
          },
        });
        input.nested.original = -1;
        const payload = { nested: { original: turn, zero: -0 } };
        yield* warm.advance({
          type: "execution.append-emission",
          request: {
            sessionId: "session",
            taskId,
            actionIndex: 0,
            descriptor: { eventType: "progress", payload },
            programCapability: opened.programCapability,
          },
        });
        payload.nested.original = -1;
        const complete = {
          type: "execution.complete-task" as const,
          request: {
            sessionId: "session",
            taskId,
            actionIndex: 1,
            outcome: { status: "ok" as const, value: { turn, zero: -0 } },
            programCapability: opened.programCapability,
          },
        };
        yield* warm.advance(complete);
        const before = yield* store.loadControl(`authority:${options.journalId}`);
        yield* warm.advance(complete);
        expect((yield* store.loadControl(`authority:${options.journalId}`))?.controlRevision).toBe(
          before?.controlRevision,
        );
        complete.request.outcome.value.turn = -1;
        const snapshot = yield* warm.exportSnapshot();
        expect(snapshot.sessions[0]![1].execution.tasks.map((task) => task.taskId)).toEqual([
          taskId,
        ]);
        expect(JSON.stringify(snapshot)).not.toContain('"original":-1');
        expect(JSON.stringify(snapshot)).not.toContain('"turn":-1');
        const cold = yield* createJournal(store, options);
        expect(yield* cold.exportSnapshot()).toEqual(snapshot);
        const records = yield* warm.readSession("session");
        expect(yield* cold.readSession("session")).toEqual(records);
        expect(new Set(records.map((record) => record.payload.taskId)).size).toBe(turn + 1);
        Reflect.set(snapshot.sessions, "length", 0);
        Reflect.set(records, "length", 0);
        expect(yield* warm.exportSnapshot()).toEqual(yield* cold.exportSnapshot());
        expect((yield* warm.readSession("session")).length).toBeGreaterThan(0);
      }
    });
  });
});
