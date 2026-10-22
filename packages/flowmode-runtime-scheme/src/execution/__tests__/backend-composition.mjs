import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHootProgram } from "../driver.mts";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  ProgramDriverRegistryContext,
  ProgramRouteResolver,
} from "@sweatpants/durable-execution";
import {
  createWorkflowProgramDriver,
  createCapabilityKeyring,
} from "@sweatpants/journal-authority";
import {
  createStoredScenarioDriver,
  driveTestProgramTree,
} from "@sweatpants/journal-authority/testing";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
const { run } = createRequire(new URL("../../../../../package.json", import.meta.url))("effection");

const childManifest = {
  programId: "generator-child",
  version: "1",
  digest: "c".repeat(64),
  inputSchema: schema,
  outputSchema: schema,
  effects: {},
  elicits: { answer: { response: schema } },
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};
const child = createPinnedDurableProgram(childManifest, function* (input, ctx) {
  const reply = yield* ctx.pull({
    kind: "elicit",
    key: "answer",
    message: input.prompt,
    response: schema,
  });
  return { answer: reply.content, received: input };
});
const childPin = {
  id: childManifest.programId,
  version: "1",
  digest: childManifest.digest,
};
const parent = createHootProgram({
  source: '(let ((answer (yield-at "child" (list "invoke" %input)))) (list %input answer))',
  contract: {
    programId: "hoot-parent",
    version: "1",
    inputSchema: schema,
    outputSchema: schema,
    effects: {},
    elicits: {},
    capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
  },
  bindOperation(request) {
    assert.equal(request.binding, "child");
    return { kind: "invoke", child: { ...childPin, input: request.input } };
  },
});
await run(function* () {
  const events = [];
  const routes = [];
  const store = createMemoryExecutionStore();
  const options = {
    journalId: "backend-composition",
    keyring: createCapabilityKeyring("test", [{ keyId: "key", secret: "x".repeat(32) }]),
  };
  let authority = yield* createStoredScenarioDriver(store, options);
  const attach = {
    sessionId: "session",
    taskId: "turn/root",
    executionEpoch: 1,
    input: { prompt: "Approve this draft", metadata: { tags: [], draft: null } },
    program: { id: parent.manifest.programId, version: "1", digest: parent.manifest.digest },
    route: { driverKind: "hoot-composition" },
  };
  yield* authority.openTask({
    ...attach,
    turnId: "turn",
    manifest: parent.manifest,
    attachmentId: "unattached",
    audience: "test",
  });
  function* advance() {
    return yield* ProgramDriverRegistryContext.with(
      new Map([
        ["hoot-composition", parent.createDriver((event) => events.push(event))],
        ["generator", createWorkflowProgramDriver(createDurableToolRegistry([child]))],
      ]),
      function* () {
        return yield* ProgramRouteResolver.with(
          function* ({ program, parentRoute }) {
            routes.push(program.id);
            return program.id === childManifest.programId
              ? { driverKind: "generator" }
              : parentRoute;
          },
          function* () {
            return yield* driveTestProgramTree(
              {
                command: authority.advance.bind(authority),
                query: authority.query.bind(authority),
              },
              { attach },
            );
          },
        );
      },
    );
  }
  const parked = yield* advance();
  assert.equal(parked.state, "parked");
  const records = yield* authority.readJournal("session");
  const pull = records.find(
    (record) => record.payload.type === "PullRequested" && record.payload.pullId === parked.pullId,
  ).payload;
  assert.equal(pull.descriptor.key, "answer");
  assert.equal(pull.descriptor.message, attach.input.prompt);
  assert.notEqual(pull.taskId, attach.taskId);
  const capability = yield* authority.resolutionCapability("session", pull.taskId, parked.pullId);
  const accepted = yield* authority.resolve({
    capability,
    audience: "user:answer",
    outcome: { status: "ok", value: { action: "accept", content: "approved" } },
  });
  assert.notEqual(accepted.status, "rejected");
  authority = yield* createStoredScenarioDriver(store, options);
  assert.deepEqual(yield* advance(), {
    state: "completed",
    value: [attach.input, { answer: "approved", received: attach.input }],
  });
  assert.ok(routes.includes("generator-child"));
  assert.equal(events.filter((event) => event === "start").length, 1);
  assert.ok(events.includes("restore"));
});
console.log(
  "PASS Hoot parent → routed Effection child → park → fresh authority/backend recovery → result",
);
