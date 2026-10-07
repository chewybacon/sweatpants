import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createStoredShellDrivers } from "../shell/stored-shell.ts";
import { run } from "effection";
import { describe, expect, it } from "vitest";

import { createMemoryExecutionStore } from "../store/memory.ts";
import { createStoredScenarioDriver } from "../testing/stored-scenario-driver.ts";
import {
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "../testing/conformance.ts";

const store = createMemoryExecutionStore();
const factory: JournalAuthorityConformanceFactory = {
  backendName: "memory-execution-store",
  *open(options) {
    return createStoredScenarioDriver(store, {
      journalId: options.journalId,
      journalIncarnation: "conformance-v1",
      keyring: options.keyring,
      now: options.now,
      schemaRegistry: options.schemaRegistry,
    });
  },
};

describe("JournalAuthority over the memory Execution Store", () => {
  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});

it("exports private snapshots before the first commit, including imported state", async () => {
  const keyring = createCapabilityKeyring("test", [
    { keyId: "test", secret: "test-secret-material-at-least-32-bytes" },
  ]);
  const initialSnapshot = { version: 1 as const, sessions: [], nextNonce: 7, records: [] };
  await run(function* () {
    for (const initial of [undefined, initialSnapshot]) {
      const drivers = createStoredShellDrivers(createMemoryExecutionStore(), {
        journalId: "unpersisted-export",
        keyring,
        initialSnapshot: initial,
      });
      const exported = yield* drivers.snapshot.exportSnapshot();
      Reflect.set(exported, "nextNonce", 999);
      Reflect.set(exported.sessions, "0", ["injected", {}]);
      const next = yield* drivers.snapshot.exportSnapshot();
      expect(next.nextNonce).toBe(initial?.nextNonce ?? 0);
      expect(next.sessions).toEqual([]);
      expect(initialSnapshot).toEqual({ version: 1, sessions: [], nextNonce: 7, records: [] });
    }
  });
});

it("reuses a validated journal view while checking control, and reloads after restart", async () => {
  const store = createMemoryExecutionStore();
  let traversals = 0;
  let controlReads = 0;
  let objectReads = 0;
  const measured = {
    ...store,
    *loadControl(executionId: string) {
      controlReads++;
      return yield* store.loadControl(executionId);
    },
    *getObject(request: Parameters<typeof store.getObject>[0]) {
      objectReads++;
      return yield* store.getObject(request);
    },
    *readJournal(request: Parameters<typeof store.readJournal>[0]) {
      traversals++;
      return yield* store.readJournal(request);
    },
  };
  const options = {
    journalId: "single-traversal",
    keyring: createCapabilityKeyring("test", [
      { keyId: "test", secret: "test-secret-material-at-least-32-bytes" },
    ]),
  };
  const drivers = createStoredShellDrivers(measured, options);
  const peer = createStoredShellDrivers(measured, options);
  await run(function* () {
    for (const sessionId of ["one", "two"]) {
      yield* drivers.authority.command({
        type: "execution.open-task",
        request: {
          sessionId,
          turnId: "turn",
          taskId: "root",
          manifest: {
            programId: "read-cost",
            version: "1",
            digest: "a".repeat(64),
            inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
            outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
            elicits: {},
            effects: {},
            capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
          },
          input: null,
          executionEpoch: 1,
          attachmentId: "attachment",
          audience: "workflow-host",
        },
      });
      traversals = 0;
      objectReads = 0;
      controlReads = 0;
      expect((yield* drivers.journal.readSession(sessionId)).length).toBeGreaterThan(0);
      expect(traversals).toBe(0);
      expect(objectReads).toBe(0);
      expect(controlReads).toBe(1);
      expect((yield* peer.journal.readSession(sessionId)).length).toBeGreaterThan(0);
      expect(traversals).toBe(1);
    }
    for (const reader of [drivers, createStoredShellDrivers(measured, options)]) {
      traversals = 0;
      const records = yield* reader.journal.readSession("one");
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.sessionId === "one")).toBe(true);
      expect(traversals).toBe(reader === drivers ? 0 : 1);
      const exported = yield* reader.snapshot.exportSnapshot();
      const expected = structuredClone(exported);
      Reflect.set(exported.sessions[0]![1].control, "revision", -1);
      Reflect.set(exported.sessions[0]![1].execution.tasks, "length", 0);
      Reflect.set(exported.records, "length", 0);
      expect(yield* reader.snapshot.exportSnapshot()).toEqual(expected);
      // A JavaScript caller can still mutate a readonly TypeScript result.
      Reflect.set(records, "length", 0);
      expect((yield* reader.journal.readSession("one")).length).toBeGreaterThan(0);
      traversals = 0;
      controlReads = 0;
      expect(yield* reader.journal.readSession("absent")).toEqual([]);
      expect(traversals).toBe(0);
      expect(controlReads).toBe(1);
    }
  });
});
