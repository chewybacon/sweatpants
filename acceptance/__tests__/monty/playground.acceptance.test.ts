// @vitest-environment node
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
import { ask } from "../../../apps/yo-workflow/src/workflow/tools/ask.ts";
import { createPythonTool } from "../../../apps/yo-workflow/src/workflow/python/tool.ts";
const python = createPythonTool([ask]);
import {
  MontyEvaluationPort,
  createMontyEvaluationDriver,
} from "@sweatpants/flowmode-runtime-monty/evaluation";
import { loadMontyModule } from "@sweatpants/flowmode-runtime-monty/node";
const evaluator = createMontyEvaluationDriver(loadMontyModule);

for (const action of ["accept", "decline", "cancel"] as const) {
  test(`real journal restores Python in fresh WASM: ${action}`, async () => {
    const source = `from sandbox import random, ask
async def main():
    choice = await random({"choices": ["rock", "paper", "scissors"]})
    answer = await ask({"message": "Rock, paper, or scissors?", "suggestions": ["rock", "paper", "scissors"]})
    if answer["action"] != "accept":
        return answer
    player = answer["content"]["reply"]
    beats = {"rock": "scissors", "paper": "rock", "scissors": "paper"}
    result = "tie" if player == choice else "win" if beats[player] == choice else "lose"
    return {"choice": choice, "answer": answer, "result": result, "misc": [None, False, 0, ""]}`;
    const tools = [python, ask];
    const registry = createDurableToolRegistry(tools);
    const attach = {
      sessionId: "hoot-journal",
      taskId: "turn-0/root",
      executionEpoch: 1,
      program: {
        id: python.manifest.programId,
        version: python.manifest.version,
        digest: python.manifest.digest,
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
            yield* MontyEvaluationPort.installDriver({
              *execute(command) {
                instances++;
                return yield* evaluator.execute(command);
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
        manifest: python.manifest,
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
      const reply = "rock";
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
      if (action === "accept") {
        const value = completed.value as {
          choice: string;
          answer: { content: { reply: string }; exchange: { messages: unknown[] } };
          misc: unknown[];
          result: string;
        };
        assert.ok(["rock", "paper", "scissors"].includes(value.choice));
        assert.ok(parked.result.outcome.status === "ok");
        assert.equal(value.choice, parked.result.outcome.value);
        assert.equal(value.answer.content.reply, reply);
        assert.equal(
          value.result,
          value.choice === "rock" ? "tie" : value.choice === "scissors" ? "win" : "lose",
        );
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

test("Python admits gathered host contracts and restores protected cancellation cleanup", async () => {
  const source = `import asyncio
from sandbox import ask, echo
async def main():
    try:
        return await asyncio.gather(ask({"message": "A?"}), ask({"message": "B?"}))
    finally:
        await echo({"message": "cleanup"})`;
  await run(function* () {
    const started = yield* evaluator.execute({ action: "start", source });
    const boundary = started.boundary as { request: { input: { operations: unknown[] } } };
    assert.equal(boundary.request.input.operations.length, 2);
    const cleanup = yield* evaluator.execute({
      action: "cancel",
      source,
      snapshot: started.snapshot,
      reason: "stop",
    });
    const pending = cleanup.boundary as {
      request: { input: { operations: { id: number; request: { capability: string } }[] } };
    };
    assert.equal(pending.request.input.operations[0].request.capability, "sandbox.echo");
    const repeated = yield* evaluator.execute({
      action: "cancel",
      source,
      snapshot: cleanup.snapshot,
      reason: "again",
    });
    const finished = yield* evaluator.execute({
      action: "resume",
      source,
      snapshot: repeated.snapshot,
      reply: { operationId: pending.request.input.operations[0].id, value: { message: "cleanup" } },
    });
    assert.deepEqual(finished.boundary, { kind: "cancelled", reason: "stop" });
  });
});
