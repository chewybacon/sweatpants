import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
  canonicalJson,
} from "@sweatpants/foundation";
import { CrankError } from "@sweatpants/durable-execution";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createDurableSchemaRegistry } from "../contract/schema-registry.ts";
import { anyGuard, createSchemaFixture } from "../testing/schema-fixtures.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { createStoredShellDrivers } from "../shell/stored-shell.ts";
import type { ExecutionStore, StoredPrivateSegment } from "../store/store.ts";

/**
 * REQ-012 — the hard-fail journal reset policy. Persisted data that cannot be
 * parsed under the current schema fails fast with an error that (1) identifies
 * the operation and the unparseable record, (2) names the data directory to
 * reset, and (3) states that pre-cutover data is disposable. No migration, no
 * dual-read, no partial recovery. (Test plan TC-012..014.)
 */

const keyring = createCapabilityKeyring("journal-reset", [
  { keyId: "test", secret: "journal-reset-secret-material-32-bytes" },
]);
const journalId = "reset-fixture";
const executionId = `authority:${journalId}`;
const dataDirectory = "/tmp/yo-chat-data-fixture";

const programInput = createSchemaFixture(
  "fixture.reset/program-input",
  "program_input",
  true,
  anyGuard,
);
const programOutput = createSchemaFixture(
  "fixture.reset/program-output",
  "program_output",
  true,
  anyGuard,
);

/** Envelope is current-schema-valid except the pre-REQ-076 pull kind. */
function preCutoverPullRecord(sessionId: string, offset: string): Json {
  return {
    offset,
    eventId: `evt-${offset}`,
    sessionId,
    payload: {
      type: "PullRequested",
      taskId: "root",
      turnId: "turn-0",
      actionIndex: 0,
      pullIndex: 0,
      pullId: "pull-0",
      descriptor: {
        kind: "foreign", // the deleted pre-cutover spelling; see REQ-011
        driver: "legacy-driver",
        tool: "book_flight",
        input: {},
        durability: "ephemeral_handle",
      },
      descriptorDigest: "b".repeat(64),
    },
  };
}

function validTaskOpenedRecord(sessionId: string, offset: string): Json {
  return {
    offset,
    eventId: `evt-${offset}`,
    sessionId,
    payload: {
      type: "TaskOpened",
      taskId: "root",
      turnId: "turn-0",
      programId: "fixture.basic",
      programVersion: "1.0.0",
      programDigest: "a".repeat(64),
      input: null,
      inputDigest: sha256(canonicalJson(null)),
    },
  };
}

type Drivers = ReturnType<typeof createStoredShellDrivers>;

function makeDrivers(store: ExecutionStore): Drivers {
  return createStoredShellDrivers(store, {
    journalId,
    keyring,
    dataDirectory,
    schemaRegistry: createDurableSchemaRegistry([programInput.entry, programOutput.entry]),
  });
}

function* seedStoredJournal(store: ExecutionStore, entries: readonly Json[]): Operation<void> {
  const body = JSON.stringify({ version: 1, nextNonce: 0, sessions: [], records: [] });
  const canonicalBody = canonicalJson(body);
  const objectPointer = yield* store.putObject({
    objectId: "snap-fixture",
    lifetimeScope: "execution",
    scopeOwnerId: executionId,
    objectKind: "authority-snapshot",
    contentHash: sha256(canonicalBody),
    byteLength: new TextEncoder().encode(canonicalBody).byteLength,
    body,
    createdAt: 0,
  });

  const encoded = canonicalSnapshot([...entries]);
  const contentHash = sha256(encoded.canonical);
  const segment: StoredPrivateSegment = {
    segmentId: stableTupleHash([executionId, "authority", "1", contentHash]),
    executionId,
    taskId: "authority",
    previous: null,
    firstSequence: "1",
    lastSequence: String(entries.length),
    entries: [...entries],
    contentHash,
    encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
    createdAt: 0,
  };

  yield* store.commitExecution({
    executionId,
    expectedControlRevision: null,
    expectedOwnerFence: "0",
    updatedAt: 0,
    nextControl: {
      executionId,
      ownerFence: "0",
      status: "parked",
      rootTaskId: "authority",
      stopGeneration: "0",
      requestedDisposition: null,
      control: {
        kind: "authority-control",
        snapshot: { id: objectPointer.objectId },
        journalHead: {
          segmentId: segment.segmentId,
          lastSequence: segment.lastSequence,
        },
        replayHead: null,
      },
    },
    journalSegments: [segment],
  });
}

const manifest = {
  programId: "fixture.basic",
  version: "1.0.0",
  digest: "a".repeat(64),
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" as const },
} as const;

function openTaskCommand(overrides?: {
  readonly taskId?: string;
  readonly turnId?: string;
  readonly attachmentId?: string;
}) {
  return {
    type: "execution.open-task" as const,
    request: {
      sessionId: "session-a",
      turnId: overrides?.turnId ?? "turn-0",
      taskId: overrides?.taskId ?? "root",
      manifest,
      input: null,
      executionEpoch: 1,
      attachmentId: overrides?.attachmentId ?? "attachment-0",
      audience: "workflow-host",
    },
  };
}

function expectResetFailure(error: unknown): asserts error is CrankError {
  expect(error).toBeInstanceOf(CrankError);
  const crank = error as CrankError;
  expect(crank.code).toBe("invalid_journal");
  // (1) operation and record identified, (2) data directory named, (3) disposability stated.
  expect(crank.message).toContain("cannot be parsed under the current schema");
  expect(crank.message).toContain(dataDirectory);
  expect(crank.message).toContain("disposable");
}

describe("hard-fail journal reset policy (REQ-012)", () => {
  it("TC-012: a pre-cutover journal fails fast with the actionable reset message", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* seedStoredJournal(store, [preCutoverPullRecord("session-a", "1")]);
      const drivers = makeDrivers(store);
      let failure: unknown;
      try {
        yield* drivers.authority.command(openTaskCommand());
      } catch (error) {
        failure = error;
      }
      expectResetFailure(failure);
      expect((failure as CrankError).message).toContain("replaying stored journal records");
      expect((failure as CrankError).message).toContain("session-a");
    });
  });

  it("TC-013: a valid prefix is not partially recovered when a later record is unparseable", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* seedStoredJournal(store, [
        validTaskOpenedRecord("session-a", "1"),
        preCutoverPullRecord("session-a", "2"),
      ]);
      const drivers = makeDrivers(store);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let failure: unknown;
        try {
          yield* drivers.authority.command(openTaskCommand());
        } catch (error) {
          failure = error;
        }
        expectResetFailure(failure);
      }
    });
  });

  it("TC-014: the documented reset action restores full operation", async () => {
    const tainted = createMemoryExecutionStore();
    await run(function* () {
      yield* seedStoredJournal(tainted, [preCutoverPullRecord("session-a", "1")]);
      const failing = makeDrivers(tainted);
      let failure: unknown;
      try {
        yield* failing.authority.command(openTaskCommand());
      } catch (error) {
        failure = error;
      }
      expectResetFailure(failure);
    });

    // "Reset" = the named data directory is deleted; a fresh store takes its place.
    const reset = createMemoryExecutionStore();
    await run(function* () {
      const drivers = makeDrivers(reset);
      const opened = yield* drivers.authority.command(openTaskCommand());
      expect(typeof opened.programCapability).toBe("string");
      yield* drivers.authority.command({
        type: "execution.append-emission",
        request: {
          sessionId: "session-a",
          taskId: "root",
          actionIndex: 0,
          descriptor: { eventType: "progress", payload: { after: "reset" } },
          programCapability: opened.programCapability,
        },
      });
    });
    await run(function* () {
      // Restart through the same store: the post-reset records parse and the
      // session remains operable.
      const restarted = makeDrivers(reset);
      const reopened = yield* restarted.authority.command(
        openTaskCommand({ taskId: "root-2", turnId: "turn-1", attachmentId: "attachment-1" }),
      );
      expect(typeof reopened.programCapability).toBe("string");
    });
  });
});
