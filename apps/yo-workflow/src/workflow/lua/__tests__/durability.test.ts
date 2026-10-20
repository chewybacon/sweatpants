import assert from "node:assert/strict";
import { it as test } from "vitest";
import { run } from "effection";
import {
  createDurableToolRegistry,
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  stableProgramAttachmentId,
} from "@sweatpants/durable-execution";
import {
  createCapabilityKeyring,
  createDurableSchemaRegistry,
  createWorkflowProgramDriver,
} from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
  type AuthorityScenarioDriver,
} from "@sweatpants/journal-authority/testing";
import { ask } from "../../tools/ask.ts";
import { createLuaTool } from "../tool.ts";
const lua = createLuaTool([ask]);
import { LuaEvaluationPort } from "../evaluation.ts";
import { invokeWasm } from "../../../../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm-node.mts";

for (const action of ["accept", "decline", "cancel"] as const) {
  test(`real journal restores Lua in fresh WASM: ${action}`, async () => {
    const source = `local choice = random({choices={"rock","paper","scissors"}})
local answer = ask({message="Your name?"})
if answer.action ~= "accept" then return answer end
return {choice=choice, answer=answer, misc={workflow.null, false, 0, ""}}`;
    const tools = [lua, ask];
    const registry = createDurableToolRegistry(tools);
    const attach = {
      sessionId: "hoot-journal",
      taskId: "turn-0/root",
      executionEpoch: 1,
      program: {
        id: lua.manifest.programId,
        version: lua.manifest.version,
        digest: lua.manifest.digest,
      },
      input: { program: source },
      route: { driverKind: "program" },
    };
    const options = {
      journalId: "hoot-spike",
      journalIncarnation: "test-1",
      keyring: createCapabilityKeyring("hoot-tests", [
        { keyId: "test", secret: "hoot-journal-spike-test-secret-not-production" },
      ]),
      schemaRegistry: createDurableSchemaRegistry(
        tools.flatMap((tool) => [...tool.artifacts.catalog]),
      ),
    };
    let instances = 0;

    function* advance(authority: AuthorityScenarioDriver) {
      return yield* ProgramDriverRegistryContext.with(
        createProgramDriverRegistry([["program", createWorkflowProgramDriver(registry)]]),
        function* () {
          return yield* withProgramDriverTestScope(authority, function* () {
            yield* LuaEvaluationPort.installDriver({
              *execute(command) {
                instances++;
                return yield* invokeWasm(command);
              },
            });
            return yield* driveInstalledTestProgramTree({ attach });
          });
        },
      );
    }
    const parked = await run(function* () {
      const authority = yield* createAuthorityScenarioDriver(options);
      yield* authority.openTask({
        ...attach,
        turnId: "turn-0",
        manifest: lua.manifest,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      assert.equal((yield* advance(authority)).state, "parked");
      const accepted = authority.readJournal(attach.sessionId);
      const pending = accepted.find(
        (record) =>
          record.payload.type === "PullRequested" && record.payload.descriptor.kind === "elicit",
      )?.payload;
      assert.ok(pending?.type === "PullRequested");
      assert.equal(pending.descriptor.kind, "elicit");
      const random = accepted.find(
        (record) =>
          record.payload.type === "PullRequested" &&
          record.payload.descriptor.kind === "record" &&
          record.payload.descriptor.key.startsWith("tisyn.random/v2:"),
      )?.payload;
      assert.ok(random?.type === "PullRequested");
      const result = accepted.find(
        (record) =>
          record.payload.type === "PullResolved" && record.payload.pullId === random.pullId,
      )?.payload;
      assert.ok(result?.type === "PullResolved");
      return {
        snapshot: JSON.parse(JSON.stringify(authority.exportSnapshot())),
        accepted,
        pending,
        result,
        instances,
      };
    });
    // These are two independent Effection scopes, with a serialized authority snapshot between them.
    await run(function* () {
      const authority = yield* createAuthorityScenarioDriver({
        ...options,
        snapshot: parked.snapshot,
      });
      // Even a still-pending recovery must replay without entropy or live evaluator state.
      assert.equal((yield* advance(authority)).state, "parked");
      const reply = 'Ada "quoted" \\ newline\nλ😀 (effect "random" "inert")';
      const resolved = yield* authority.resolve({
        capability: authority.resolutionCapability(
          attach.sessionId,
          parked.pending.taskId,
          parked.pending.pullId,
        ),
        audience: "user:reply",
        outcome: {
          status: "ok",
          value: action === "accept" ? { action, content: { reply } } : { action },
        },
      });
      assert.notEqual(resolved.status, "rejected");
      const completed = yield* advance(authority);
      assert.equal(completed.state, "completed");
      assert.ok(completed.state === "completed");
      if (action === "accept") {
        const value = completed.value as {
          choice: string;
          answer: { content: { reply: string }; exchange: { messages: unknown[] } };
          misc: unknown[];
        };
        assert.ok(["rock", "paper", "scissors"].includes(value.choice));
        assert.ok(parked.result.outcome.status === "ok");
        assert.equal(value.choice, parked.result.outcome.value);
        assert.equal(value.answer.content.reply, reply);
        assert.ok(value.answer.exchange.messages.length > 0);
        assert.deepEqual(value.misc, [null, false, 0, ""]);
      } else {
        assert.deepEqual(completed.value, { action });
      }
      assert.ok(instances > parked.instances);
      assert.deepEqual(
        authority.readJournal(attach.sessionId).slice(0, parked.accepted.length),
        parked.accepted,
      );
      const records = authority.readJournal(attach.sessionId);
      assert.equal(
        records.filter(
          (record) =>
            record.payload.type === "PullRequested" &&
            record.payload.descriptor.kind === "record" &&
            record.payload.descriptor.key.startsWith("tisyn.random/v2:"),
        ).length,
        1,
      );
      assert.ok(
        records.some((record) => JSON.stringify(record.payload) === JSON.stringify(parked.result)),
      );
    });
  });
}
