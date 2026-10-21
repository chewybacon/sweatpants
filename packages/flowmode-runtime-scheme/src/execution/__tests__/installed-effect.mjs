import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { emitWorkflowScheme } from "@sweatpants/flowmode-compiler/emit-scheme";
import { createHootProgram } from "../driver.mjs";
import {
  createStoredScenarioDriver,
  driveTestProgramTree,
  createSchemaFixture,
} from "@sweatpants/journal-authority/testing";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import {
  createCapabilityKeyring,
  createDurableSchemaRegistry,
} from "@sweatpants/journal-authority";
import {
  ProgramDriverRegistryContext,
  ANY_JSON_SCHEMA_DESCRIPTOR,
} from "@sweatpants/durable-execution";
import { defineDurableEffect } from "../../../../durable-effects/dist/authoring.js";
import { createDurableEffectRegistration } from "../../../../durable-effects/dist/index.js";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "../../../../durable-effects/dist/runtime.js";
const { run } = createRequire(new URL("../../../../../package.json", import.meta.url))("effection");
const message = { text: "Hello", recipients: ["test"], metadata: null };
const receiptValue = { id: "message-17", details: [null, {}, [], false, 1.25] };
const input = createSchemaFixture(
  "message/input",
  "effect_input",
  {
    type: "object",
    required: ["text", "recipients", "metadata"],
    properties: {
      text: { type: "string" },
      recipients: { type: "array", items: { type: "string" } },
      metadata: { type: "null" },
    },
  },
  (value) => (JSON.stringify(value) === JSON.stringify(message) ? undefined : "Invalid message"),
);
const output = createSchemaFixture(
  "message/output",
  "effect_output",
  {
    type: "object",
    required: ["id", "details"],
    properties: { id: { type: "string" }, details: { type: "array" } },
  },
  (value) =>
    JSON.stringify(value) === JSON.stringify(receiptValue) ? undefined : "Invalid receipt",
);
const definition = defineDurableEffect({
  name: "message.send",
  version: "1",
  inputSchema: input.descriptor,
  outputSchema: output.descriptor,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});
const installedEffects = [{ module: "integrations", export: "sendMessage", definition }];
const developer = `import { sendMessage as send } from "integrations";
function* workflow(ctx) {
  "use workflow";
  const receipt = yield* ctx.effect(send, { text: "Hello", recipients: ["test"], metadata: null });
  const answer = yield* ctx.elicit("continue", "Continue?");
  return receipt;
}`;
assert.throws(() => emitWorkflowScheme(developer), /Unsupported import/);
assert.throws(
  () =>
    emitWorkflowScheme(developer.replace("ctx.effect(send,", "ctx.effect(unknown,"), {
      installedEffects,
    }),
  /installed effect/,
);
assert.throws(
  () =>
    emitWorkflowScheme(developer.replace("workflow(ctx)", "workflow(ctx, send)"), {
      installedEffects,
    }),
  /Shadowed/,
);

for (const mode of ["success", "invalid-input", "host-denied"]) {
  const emitted = emitWorkflowScheme(
    mode === "invalid-input"
      ? developer.replace(
          'send, { text: "Hello", recipients: ["test"], metadata: null }',
          "send, 42",
        )
      : developer,
    { installedEffects },
  );
  assert.equal(emitted.debug.sites["workflow/receipt"].name, definition.name);
  const program = createHootProgram({
    source: emitted.scheme,
    contract: {
      programId: "installed-message",
      version: "1",
      inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      effects: { [definition.name]: definition },
      elicits: { continue: { response: ANY_JSON_SCHEMA_DESCRIPTOR } },
      capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
    },
    bindOperation({ binding, input: exchangeInput, site }) {
      const request = JSON.parse(binding);
      if (request[0] === "effect") {
        assert.equal(request[1], definition.name);
        assert.equal(request[2], definition.version);
        return {
          kind: "effect",
          name: request[1],
          version: request[2],
          input: exchangeInput,
          resolver: { audience: "host:message" },
        };
      }
      assert.equal(request[0], "elicit");
      return {
        kind: "elicit",
        key: "continue",
        message: exchangeInput.message,
        response: ANY_JSON_SCHEMA_DESCRIPTOR,
        binding: { id: site },
      };
    },
  });
  await run(function* () {
    const store = createMemoryExecutionStore();
    const options = {
      journalId: "effect-proof",
      keyring: createCapabilityKeyring("proof", [{ keyId: "key", secret: "x".repeat(32) }]),
      schemaRegistry: createDurableSchemaRegistry([input.entry, output.entry]),
    };
    let authority = yield* createStoredScenarioDriver(store, options);
    let executions = 0;
    const hostCredential = "host-only-test-credential";
    const effects = createDurableEffectRegistry([
      createDurableEffectRegistration(definition, definition.retrySafety, function* (value) {
        executions++;
        assert.equal(hostCredential, "host-only-test-credential");
        assert.deepEqual(value, message);
        return mode === "host-denied"
          ? {
              status: "error",
              error: { code: "access_denied", message: "Host policy denied delivery" },
            }
          : { status: "ok", value: receiptValue };
      }),
    ]);
    const attach = {
      sessionId: "session",
      taskId: "turn/root",
      input: null,
      executionEpoch: 1,
      program: {
        id: program.manifest.programId,
        version: "1",
        digest: program.manifest.digest,
      },
      route: { driverKind: "hoot-composition" },
    };
    yield* authority.openTask({
      ...attach,
      turnId: "turn",
      manifest: program.manifest,
      attachmentId: "unattached",
      audience: "fixture",
    });
    const events = [];
    function* advance() {
      return yield* ProgramDriverRegistryContext.with(
        new Map([["hoot-composition", program.createDriver((e) => events.push(e))]]),
        function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* driveTestProgramTree(
              {
                command: authority.advance.bind(authority),
                query: authority.query.bind(authority),
              },
              { attach },
            );
          });
        },
      );
    }
    if (mode === "invalid-input") {
      let rejected;
      try {
        yield* advance();
      } catch (error) {
        rejected = error;
      }
      assert.equal(rejected?.code, "invalid_descriptor");
      assert.equal(executions, 0);
      console.log("PASS invalid input rejected by authority before host execution");
      return;
    }
    const first = yield* advance();
    if (mode !== "success") {
      assert.equal(first.state, "failed", JSON.stringify(first));
      assert.deepEqual(JSON.parse(first.error.message), {
        code: "access_denied",
        message: "Host policy denied delivery",
      });
      assert.equal(executions, mode === "invalid-input" ? 0 : 1);
      console.log("PASS installed effect", mode, first);
      return;
    }
    assert.equal(first.state, "parked");
    assert.equal(executions, 1);
    const saved = yield* authority.exportSnapshot();
    assert.ok(!JSON.stringify(saved).includes(hostCredential));
    assert.ok(!emitted.scheme.includes(hostCredential));
    assert.equal(saved.sessions[0][1].execution.tasks[0].execution.checkpoint.kind, "continuation");
    const capability = yield* authority.resolutionCapability(
      attach.sessionId,
      attach.taskId,
      first.pullId,
    );
    const accepted = yield* authority.resolve({
      capability,
      audience: "user:continue",
      outcome: { status: "ok", value: { action: "accept", content: true } },
    });
    assert.notEqual(accepted.status, "rejected");
    authority = yield* createStoredScenarioDriver(store, options);
    const last = yield* advance();
    assert.deepEqual(last, { state: "completed", value: receiptValue });
    assert.equal(executions, 1, "fresh recovery must not send again");
    assert.equal(events.filter((e) => e === "start").length, 1);
    assert.equal(events.filter((e) => e === "restore").length, 1);
    console.log(
      "PASS installed host effect + journal + fresh Hoot recovery, execution count",
      executions,
    );
  });
}
