import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  ProgramPeer,
  ProgramRecovery,
  recoverProgram,
  installProgramCheckpointAcceleration,
  ProgramDriverRegistryContext,
} from "../../../../packages/durable-execution/dist/index.js";
import { canonicalDigest } from "../../../../packages/foundation/dist/index.js";
import {
  createHootDriver,
  manifest,
} from "../../../../packages/flowmode-runtime-scheme/src/execution/__tests__/fixtures/fixture-driver.mjs";

const { run, scoped, spawn, suspend, withResolvers } = createRequire(
  new URL("../../../../package.json", import.meta.url),
)("effection");
const attach = {
  sessionId: "recovery-policy",
  taskId: "root",
  program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
  input: null,
  route: { driverKind: "hoot-composition" },
  executionEpoch: 1,
};
const seed = "authority-test-seed";
const events = [];
const history = [];
let checkpoint;
let expectedFrontier;

// Establish accepted-history fixtures using a real Hoot driver. This test owns
// the receipts; it exercises recovery policy, not authority admission/security.
await run(function* () {
  const driver = createHootDriver();
  const attachment = yield* driver.attach(attach);
  try {
    let step = yield* driver.step(attachment, { type: "start", input: null });
    let previous = seed;
    for (const content of ["hold-17", "approved"]) {
      const outcome = { status: "ok", value: { action: "accept", content } };
      const receipt = {
        sessionId: attach.sessionId,
        taskId: attach.taskId,
        pullId: `pull-${history.length}`,
        resolutionOffset: String(history.length + 1),
        status: "accepted",
        outcomeDigest: canonicalDigest(outcome),
      };
      const body = {
        type: "operation",
        actionIndex: step.actionIndex,
        descriptorKind: step.descriptor.kind,
        descriptorDigest: canonicalDigest(step.descriptor),
        previousEntryDigest: previous,
        outcome,
        receipt,
      };
      const entry = {
        ...body,
        entryDigest: canonicalDigest({
          replayChainSeed: seed,
          previousEntryDigest: previous,
          entryWithoutEntryDigest: body,
        }),
      };
      history.push(entry);
      step = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: entry.actionIndex,
        outcome,
        receipt,
        replayed: true,
      });
      previous = entry.entryDigest;
      if (history.length === 1) {
        checkpoint = {
          ...(yield* driver.checkpoint(attachment)),
          resumeAfter: { actionIndex: 0, replayChainDigest: previous },
        };
      }
    }
    expectedFrontier = step;
  } finally {
    yield* driver.shutdown(attachment, "parked");
  }
});
const request = {
  attach,
  checkpoint,
  replay: history,
  replayChainSeed: seed,
  replayChainDigest: history.at(-1).entryDigest,
  replayedThroughActionIndex: 1,
};
const acceleration = { driverKind: "hoot-composition", format: checkpoint.format };

function* recoverAndClose(input = request) {
  const recovered = yield* recoverProgram(input);
  try {
    assert.deepEqual(recovered.frontier, expectedFrontier);
  } finally {
    yield* ProgramPeer.operations.shutdown(recovered.attachment, "parked");
  }
}

await run(function* () {
  const driver = createHootDriver((event) => events.push(event));
  yield* ProgramDriverRegistryContext.set(new Map([["hoot-composition", driver]]));

  // Default uses complete history despite an available checkpoint.
  yield* recoverAndClose();
  assert.equal(events.filter((event) => event === "start").length, 1);
  assert.equal(events.filter((event) => event === "restore").length, 0);
  assert.deepEqual(yield* ProgramRecovery.operations.checkpoint({}), { kind: "replay" });

  // Capture uses the selected peer; other driver kinds retain replay defaults.
  yield* scoped(function* () {
    yield* installProgramCheckpointAcceleration(acceleration);
    assert.deepEqual(
      yield* ProgramRecovery.operations.checkpoint({ driverKind: "another-driver" }),
      { kind: "replay" },
    );
    const recovered = yield* recoverProgram(request);
    try {
      const captured = yield* ProgramRecovery.operations.checkpoint(recovered.attachment);
      assert.equal(captured.kind, "continuation");
      assert.equal(captured.format, checkpoint.format);
    } finally {
      yield* ProgramPeer.operations.shutdown(recovered.attachment, "parked");
    }
  });

  // Concurrent sibling scopes: only one inherits the accelerator.
  events.length = 0;
  const accelerated = yield* spawn(function* () {
    yield* installProgramCheckpointAcceleration(acceleration);
    yield* scoped(function* () {
      yield* recoverAndClose();
    });
  });
  const ordinary = yield* spawn(() => recoverAndClose());
  yield* accelerated;
  yield* ordinary;
  assert.equal(events.filter((event) => event === "start").length, 1);
  assert.equal(events.filter((event) => event === "restore").length, 1);

  // Unknown formats delegate before allocating compute.
  events.length = 0;
  yield* scoped(function* () {
    yield* installProgramCheckpointAcceleration({ ...acceleration, format: "unsupported" });
    yield* recoverAndClose();
  });
  assert.ok(events.includes("start"));
  assert.ok(!events.includes("restore"));

  // Policy and observation surround min-installed acceleration in either order.
  for (const installFirst of [true, false]) {
    const observed = [];
    events.length = 0;
    yield* scoped(function* () {
      if (installFirst) {
        yield* installProgramCheckpointAcceleration(acceleration);
      }
      yield* ProgramRecovery.around({
        *recover([input], next) {
          observed.push("before");
          const result = yield* next({ ...input, checkpoint: { kind: "replay" } });
          observed.push("after");
          return result;
        },
        *checkpoint() {
          return { kind: "replay" };
        },
      });
      if (!installFirst) {
        yield* installProgramCheckpointAcceleration(acceleration);
      }
      yield* recoverAndClose();
      assert.deepEqual(yield* ProgramRecovery.operations.checkpoint({}), { kind: "replay" });
    });
    assert.deepEqual(observed, ["before", "after"]);
    assert.ok(events.includes("start"));
    assert.ok(!events.includes("restore"));
  }
});
console.log(
  "PASS real Hoot replay/snapshot parity, sibling isolation, inheritance, format fallback, policy ordering",
);

// Invalid evidence is rejected before middleware, including middleware that
// would otherwise bypass recovery entirely.
for (const invalid of [
  { ...request, replayChainDigest: "wrong" },
  { ...request, replay: [{ ...history[0], entryDigest: "wrong" }, history[1]] },
  { ...request, checkpoint: { ...checkpoint, programDigest: "wrong" } },
  {
    ...request,
    checkpoint: { ...checkpoint, resumeAfter: { actionIndex: 0, replayChainDigest: "wrong" } },
  },
]) {
  let intercepted = false;
  await assert.rejects(
    run(function* () {
      yield* ProgramRecovery.around({
        *recover() {
          intercepted = true;
        },
      });
      yield* recoverProgram(invalid);
    }),
  );
  assert.equal(intercepted, false);
}
console.log("PASS mandatory evidence checks surround middleware");

// A matching but corrupt backend snapshot fails; no catch-and-replay occurs.
events.length = 0;
await assert.rejects(
  run(function* () {
    yield* ProgramDriverRegistryContext.set(
      new Map([["hoot-composition", createHootDriver((event) => events.push(event))]]),
    );
    yield* installProgramCheckpointAcceleration(acceleration);
    yield* recoverProgram({ ...request, checkpoint: { ...checkpoint, state: null } });
  }),
);
assert.ok(!events.includes("start"));
console.log("PASS corrupt supported checkpoint fails without replay fallback");

// Controlled backend pauses after acquiring compute, so cancellation can reach
// a restoration suspension deterministically. Cleanup remains backend-owned.
const cleanup = [];
await run(function* () {
  const acquired = withResolvers();
  const restoring = yield* spawn(function* () {
    yield* ProgramDriverRegistryContext.set(
      new Map([
        [
          "hoot-composition",
          {
            *restore() {
              cleanup.push("acquire");
              try {
                acquired.resolve();
                yield* suspend();
              } finally {
                cleanup.push("release");
              }
            },
          },
        ],
      ]),
    );
    yield* installProgramCheckpointAcceleration(acceleration);
    yield* recoverProgram(request);
  });
  yield* acquired.operation;
  yield* restoring.halt();
});
assert.deepEqual(cleanup, ["acquire", "release"]);
console.log("PASS cancellation unwinds partially acquired backend compute");

// Even a middleware-returned result must meet the planned head; release its
// attachment if it does not. Middleware is trusted code, not an authority.
const rejected = [];
await assert.rejects(
  run(function* () {
    yield* ProgramDriverRegistryContext.set(
      new Map([
        [
          "fake",
          {
            *shutdown(_attachment, reason) {
              rejected.push(reason);
            },
          },
        ],
      ]),
    );
    yield* ProgramRecovery.around({
      *recover() {
        return {
          attachment: { driverKind: "fake" },
          frontier: expectedFrontier,
          frontierDigest: canonicalDigest(expectedFrontier),
          replayChainDigest: "wrong",
          replayedThroughActionIndex: 1,
        };
      },
    });
    yield* recoverProgram(request);
  }),
  /Recovery result differs/,
);
assert.deepEqual(rejected, ["failed"]);
console.log("PASS invalid recovered frontier releases returned attachment");
