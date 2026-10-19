import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildBundle } from "./build.mjs";
import { createCompiledPullTool } from "./pull-adapter.mjs";
import { createReferenceWorkflowDriver } from "./reference-kernel.mjs";
import { canonicalDigest } from "../../../packages/foundation/dist/index.js";
const { run } = createRequire(new URL("../../../package.json", import.meta.url))("effection");
const bundle = buildBundle(
  fs.readFileSync(new URL("../tool-contracts/iteration-scope.ts", import.meta.url), "utf8"),
);
const tool = createCompiledPullTool(bundle);
const attach = {
  sessionId: "s",
  taskId: "t",
  program: {
    id: tool.manifest.programId,
    version: tool.manifest.version,
    digest: tool.manifest.digest,
  },
  input: { count: 1 },
  route: { driverKind: "compiled-spike" },
  executionEpoch: 1,
};
const outcome = { status: "ok", value: { action: "accept", content: { id: "hold-1" } } };
const receipt = {
  sessionId: "s",
  taskId: "t",
  pullId: "p",
  resolutionOffset: "1",
  outcomeDigest: canonicalDigest(outcome),
  status: "accepted",
};
let snapshot;
const originalEvents = [];
await run(function* () {
  const driver = createReferenceWorkflowDriver(bundle, (event) => originalEvents.push(event));
  const attachment = yield* driver.attach(attach);
  const first = yield* driver.step(attachment, { type: "start", input: attach.input });
  assert.equal(first.descriptor.key, "acquire");
  const release = yield* driver.step(attachment, {
    type: "resume",
    actionIndex: 0,
    outcome,
    receipt,
    replayed: true,
  });
  assert.equal(release.descriptor.key, "release");
  snapshot = JSON.parse(JSON.stringify(yield* driver.checkpoint(attachment)));
  yield* driver.shutdown(attachment, "parked");
});
assert.deepEqual(originalEvents, ["start", "dispose", "close"]);
const restoredEvents = [];
await run(function* () {
  const driver = createReferenceWorkflowDriver(bundle, (event) => restoredEvents.push(event));
  const restored = yield* driver.restore({
    attach: { ...attach, executionEpoch: 2 },
    checkpoint: {
      ...snapshot,
      resumeAfter: { actionIndex: 0, replayChainDigest: "accepted-prefix" },
    },
    replay: [],
    replayedThroughActionIndex: 0,
    replayChainSeed: "seed",
    replayChainDigest: "accepted-prefix",
  });
  assert.equal(restored.frontier.descriptor.key, "release");
  assert.equal(restored.frontier.actionIndex, 1);
  const released = { status: "ok", value: { action: "accept", content: "released" } };
  const end = yield* driver.step(restored.attachment, {
    type: "resume",
    actionIndex: 1,
    outcome: released,
    receipt: {
      ...receipt,
      pullId: "release",
      resolutionOffset: "2",
      outcomeDigest: canonicalDigest(released),
    },
    replayed: true,
  });
  assert.deepEqual(end, { type: "completed", actionIndex: 2, value: 0 });
  yield* driver.shutdown(restored.attachment, "completed");
});
assert.deepEqual(restoredEvents, ["restore", "dispose", "close"]);
console.log(
  "Real evaluator checkpoint → discard → fresh driver restore → cleanup → completion passed; no prefix replay or cancellation.",
);

// A reply accepted after capture must be applied exactly once as a replay suffix.
const released = { status: "ok", value: { action: "accept", content: "released" } };
const releaseDescriptor = await run(function* () {
  const driver = createReferenceWorkflowDriver(bundle);
  const restored = yield* driver.restore({
    attach,
    checkpoint: {
      ...snapshot,
      resumeAfter: { actionIndex: 0, replayChainDigest: "accepted-prefix" },
    },
    replay: [],
    replayedThroughActionIndex: 0,
    replayChainSeed: "seed",
    replayChainDigest: "accepted-prefix",
  });
  return restored.frontier.descriptor;
});
const body = {
  type: "operation",
  actionIndex: 1,
  descriptorKind: "elicit",
  descriptorDigest: canonicalDigest(releaseDescriptor),
  previousEntryDigest: "accepted-prefix",
  outcome: released,
  receipt: {
    ...receipt,
    pullId: "release",
    resolutionOffset: "2",
    outcomeDigest: canonicalDigest(released),
  },
};
const entry = {
  ...body,
  entryDigest: canonicalDigest({
    replayChainSeed: "seed",
    previousEntryDigest: "accepted-prefix",
    entryWithoutEntryDigest: body,
  }),
};
const suffixEvents = [];
await run(function* () {
  const driver = createReferenceWorkflowDriver(bundle, (event) => suffixEvents.push(event));
  const restored = yield* driver.restore({
    attach,
    checkpoint: {
      ...snapshot,
      resumeAfter: { actionIndex: 0, replayChainDigest: "accepted-prefix" },
    },
    replay: [entry],
    replayedThroughActionIndex: 1,
    replayChainSeed: "seed",
    replayChainDigest: entry.entryDigest,
  });
  assert.deepEqual(restored.frontier, { type: "completed", actionIndex: 2, value: 0 });
});
assert.deepEqual(suffixEvents, ["restore", "dispose", "close"]);

for (const mutate of [
  (request) => {
    request.attach.input = { count: 2 };
  },
  (request) => {
    request.attach.taskId = "other";
  },
  (request) => {
    request.checkpoint.resumeAfter.actionIndex = 1;
  },
  (request) => {
    request.checkpoint.format = "other";
  },
  (request) => {
    request.checkpoint.state.backend.kernel.version = "other";
  },
]) {
  const request = structuredClone({
    attach,
    checkpoint: {
      ...snapshot,
      resumeAfter: { actionIndex: 0, replayChainDigest: "accepted-prefix" },
    },
    replay: [],
    replayedThroughActionIndex: 0,
    replayChainSeed: "seed",
    replayChainDigest: "accepted-prefix",
  });
  mutate(request);
  const events = [];
  await assert.rejects(
    run(() =>
      createReferenceWorkflowDriver(bundle, (event) => events.push(event)).restore(request),
    ),
    /differs/,
  );
  assert.deepEqual(events, []);
}
const corruptEvents = [];
await assert.rejects(
  run(() =>
    createReferenceWorkflowDriver(bundle, (event) => corruptEvents.push(event)).restore({
      attach,
      checkpoint: {
        ...snapshot,
        resumeAfter: { actionIndex: 0, replayChainDigest: "accepted-prefix" },
      },
      replay: [{ ...entry, entryDigest: "corrupt" }],
      replayedThroughActionIndex: 1,
      replayChainSeed: "seed",
      replayChainDigest: entry.entryDigest,
    }),
  ),
  /Replay entry digest differs/,
);
assert.deepEqual(corruptEvents, ["restore", "dispose", "close"]);
console.log(
  "Accepted suffix, wrong task/input/position/format/kernel, and corrupt-history cleanup passed.",
);
