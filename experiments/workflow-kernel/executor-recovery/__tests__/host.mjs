import assert from "node:assert/strict";
import { run, scoped } from "effection";
import {
  createHootDriver,
  manifest,
} from "../../../../packages/flowmode-runtime-scheme/src/execution/__tests__/fixtures/fixture-driver.mjs";
import {
  createStoredScenarioDriver,
  driveTestProgramTree,
} from "../../../../packages/journal-authority/dist/testing.js";
import { createMemoryExecutionStore } from "../../../../packages/journal-authority/dist/memory.js";
import { createCapabilityKeyring } from "../../../../packages/journal-authority/dist/index.js";
import {
  ProgramRecovery,
  ProgramDriverRegistryContext,
} from "../../../../packages/durable-execution/dist/index.js";
import { KernelExecutor } from "../../../../packages/flowmode-runtime/src/execution.ts";

// The test host composes the production authority and activation/tree drivers.
// It exposes parks directly; this is not HTTP, provider, or deployment coverage.
const attach = {
  sessionId: "host-recovery",
  taskId: "turn-0/root",
  program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
  input: null,
  route: { driverKind: "hoot-composition" },
  executionEpoch: 1,
};
const options = {
  journalId: "host-recovery-proof",
  keyring: createCapabilityKeyring("proof", [{ keyId: "key", secret: "x".repeat(32) }]),
};

// Mechanical host lifetime: only the execution store survives this scope.
// All assertions about progression and compute replacement stay in the scenario.
function activateFreshHost(store, { replayOnly = false } = {}) {
  return scoped(function* () {
    const authority = yield* createStoredScenarioDriver(store, options);
    const events = [],
      starts = [];
    const driver = createHootDriver((event) => events.push(event));
    if (replayOnly) {
      yield* ProgramRecovery.around({
        *checkpoint() {
          return { kind: "replay" };
        },
        *recover([request], next) {
          return yield* next({ ...request, checkpoint: { kind: "replay" } });
        },
      });
    }
    yield* KernelExecutor.api.around({
      *start([program, input], next) {
        starts.push("before");
        const executionState = yield* next(program, input);
        starts.push(executionState.boundary.kind);
        return executionState;
      },
    });
    const result = yield* ProgramDriverRegistryContext.with(
      new Map([["hoot-composition", driver]]),
      () =>
        driveTestProgramTree(
          {
            command: authority.advance.bind(authority),
            query: authority.query.bind(authority),
          },
          { attach },
        ),
    );
    const journal = yield* authority.readJournal(attach.sessionId);
    const snapshot = yield* authority.exportSnapshot();
    const checkpoint = snapshot.sessions[0][1].execution.tasks[0].execution.checkpoint;
    const pull =
      result.state === "parked"
        ? journal.find(
            (record) =>
              record.payload.type === "PullRequested" && record.payload.pullId === result.pullId,
          )?.payload
        : undefined;
    return { result, pull, checkpoint, events, starts, journal };
  });
}

// Named semantic operation: resolve through the authority's real capability and
// acceptance path, then discard this authority shell as well.
function acceptAnswer(store, pull, content) {
  return scoped(function* () {
    const authority = yield* createStoredScenarioDriver(store, options);
    const capability = yield* authority.resolutionCapability(
      attach.sessionId,
      attach.taskId,
      pull.pullId,
    );
    return yield* authority.resolve({
      capability,
      audience: "user:" + pull.descriptor.key,
      outcome: { status: "ok", value: { action: "accept", content } },
    });
  });
}

const snapshotResult = await run(function* () {
  const store = createMemoryExecutionStore();
  yield* scoped(function* () {
    const authority = yield* createStoredScenarioDriver(store, options);
    yield* authority.openTask({
      ...attach,
      turnId: "turn-0",
      manifest,
      attachmentId: "unattached",
      audience: "fixture",
    });
  });

  // Host 1 parks for a reservation, saves its checkpoint, and releases Wasm.
  const reservation = yield* activateFreshHost(store);
  assert.equal(reservation.result.state, "parked");
  assert.equal(reservation.pull.descriptor.key, "reserve");
  assert.equal(reservation.checkpoint.kind, "continuation");
  assert.deepEqual(reservation.starts, ["before", "suspended"]);
  assert.deepEqual(reservation.events, ["start", "capture", "dispose"]);
  const reserved = yield* acceptAnswer(store, reservation.pull, "hold-17");
  assert.equal(reserved.status, "accepted");

  // Host 2 has no live handle. Its journal plan restores the saved reservation,
  // applies the accepted reply, and parks for approval with the hold in state.
  const approval = yield* activateFreshHost(store);
  assert.equal(approval.result.state, "parked");
  assert.equal(approval.pull.descriptor.key, "approve");
  assert.equal(approval.pull.descriptor.message, "hold-17");
  assert.equal(approval.checkpoint.kind, "continuation");
  assert.ok(JSON.stringify(approval.checkpoint).includes("hold-17"));
  assert.deepEqual(approval.starts, ["before", "suspended"]);
  assert.deepEqual(approval.events, [
    "checkpoint-selected",
    "restore",
    "reply",
    "resume",
    "capture",
    "dispose",
  ]);
  const approved = yield* acceptAnswer(store, approval.pull, "approved");
  assert.equal(approved.status, "accepted");

  // Host 3 restores the nested continuation and parks inside its cleanup.
  const cleanup = yield* activateFreshHost(store);
  assert.equal(cleanup.result.state, "parked");
  assert.equal(cleanup.pull.descriptor.key, "release");
  assert.equal(cleanup.pull.descriptor.message, "hold-17");
  assert.equal(cleanup.checkpoint.kind, "continuation");
  assert.deepEqual(cleanup.starts, ["before", "suspended"]);
  assert.deepEqual(cleanup.events, [
    "checkpoint-selected",
    "restore",
    "reply",
    "resume",
    "capture",
    "dispose",
  ]);
  const released = yield* acceptAnswer(store, cleanup.pull, "released");
  assert.equal(released.status, "accepted");

  // Host 4 restores pending cleanup and returns through the original caller.
  const finished = yield* activateFreshHost(store);
  assert.deepEqual(finished.result, { state: "completed", value: "Caller received: approved" });
  assert.deepEqual(finished.starts, ["before", "suspended"]);
  assert.deepEqual(finished.events, [
    "checkpoint-selected",
    "restore",
    "reply",
    "resume",
    "capture",
    "dispose",
  ]);
  const requests = finished.journal.filter((record) => record.payload.type === "PullRequested");
  assert.deepEqual(
    requests.map((record) => record.payload.descriptor.key),
    ["reserve", "approve", "release"],
  );
  assert.equal(new Set(requests.map((record) => record.payload.pullId)).size, 3);
  return {
    result: finished.result,
    descriptors: requests.map((record) => record.payload.descriptor),
  };
});
console.log(
  "PASS durable host: journal-owned checkpoints, four fresh host scopes, middleware on every restore, cleanup completion, no duplicate pulls",
);

// Same accepted work, but deployment policy disables checkpoint acceleration.
// Every host starts a fresh evaluator and replays only journal-accepted replies.
await run(function* () {
  const store = createMemoryExecutionStore();
  yield* scoped(function* () {
    const authority = yield* createStoredScenarioDriver(store, options);
    yield* authority.openTask({
      ...attach,
      turnId: "turn-0",
      manifest,
      attachmentId: "unattached",
      audience: "fixture",
    });
  });
  // Replay markers select policy; only continuation payloads are persisted.
  const replayOnly = true;
  const reservation = yield* activateFreshHost(store, { replayOnly });
  assert.equal(reservation.result.state, "parked");
  assert.equal(reservation.pull.descriptor.key, "reserve");
  assert.equal(reservation.checkpoint, undefined);
  assert.deepEqual(reservation.starts, ["before", "suspended"]);
  assert.deepEqual(reservation.events, ["start", "dispose"]);
  const reserved = yield* acceptAnswer(store, reservation.pull, "hold-17");
  assert.equal(reserved.status, "accepted");

  const approval = yield* activateFreshHost(store, { replayOnly });
  assert.equal(approval.result.state, "parked");
  assert.equal(approval.pull.descriptor.key, "approve");
  assert.equal(approval.checkpoint, undefined);
  assert.deepEqual(approval.starts, ["before", "suspended"]);
  assert.deepEqual(approval.events, ["start", "reply", "resume", "dispose"]);
  const approved = yield* acceptAnswer(store, approval.pull, "approved");
  assert.equal(approved.status, "accepted");

  const cleanup = yield* activateFreshHost(store, { replayOnly });
  assert.equal(cleanup.result.state, "parked");
  assert.equal(cleanup.pull.descriptor.key, "release");
  assert.equal(cleanup.checkpoint, undefined);
  assert.deepEqual(cleanup.starts, ["before", "suspended"]);
  assert.deepEqual(cleanup.events, ["start", "reply", "resume", "reply", "resume", "dispose"]);
  const released = yield* acceptAnswer(store, cleanup.pull, "released");
  assert.equal(released.status, "accepted");

  const finished = yield* activateFreshHost(store, { replayOnly });
  assert.deepEqual(finished.result, { state: "completed", value: "Caller received: approved" });
  assert.deepEqual(finished.starts, ["before", "suspended"]);
  assert.deepEqual(finished.events, [
    "start",
    "reply",
    "resume",
    "reply",
    "resume",
    "reply",
    "resume",
    "dispose",
  ]);
  const requests = finished.journal.filter((record) => record.payload.type === "PullRequested");
  assert.equal(new Set(requests.map((record) => record.payload.pullId)).size, 3);
  assert.deepEqual(
    {
      result: finished.result,
      descriptors: requests.map((record) => record.payload.descriptor),
    },
    snapshotResult,
  );
});
console.log(
  "PASS durable host: scoped replay-only policy, four fresh evaluators, same journal requests and completion as snapshots",
);
