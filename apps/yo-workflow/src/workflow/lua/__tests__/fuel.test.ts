import { expect, it } from "vitest";
import { assertJson } from "@sweatpants/foundation";
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
import { computationApproval } from "../../tools/computation-approval.ts";
import { createLuaTool } from "../tool.ts";
import { LuaEvaluationPort } from "../evaluation.ts";
import { invokeWasm } from "../../../../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm-node.mts";

it.each(["accept", "cancel"] as const)(
  "durably restores a computation approval and handles %s",
  async (action) => {
    const lua = createLuaTool([], { sliceFuel: 500, allowanceFuel: 2000 });
    const tools = [lua, computationApproval];
    const registry = createDurableToolRegistry(tools);
    const attach = {
      sessionId: "fuel-test",
      taskId: "turn-0/root",
      executionEpoch: 1,
      program: {
        id: lua.manifest.programId,
        version: lua.manifest.version,
        digest: lua.manifest.digest,
      },
      input: { program: "local n = 0 for i = 1, 1000 do n = n + 1 end return n" },
      route: { driverKind: "program" },
    };
    const options = {
      journalId: "fuel",
      journalIncarnation: "test",
      keyring: createCapabilityKeyring("fuel-tests", [
        { keyId: "test", secret: "fuel-test-secret-not-production-at-least-32-bytes" },
      ]),
      schemaRegistry: createDurableSchemaRegistry(
        tools.flatMap((tool) => [...tool.artifacts.catalog]),
      ),
    };
    const commands: unknown[] = [];
    function* advance(authority: AuthorityScenarioDriver) {
      return yield* ProgramDriverRegistryContext.with(
        createProgramDriverRegistry([["program", createWorkflowProgramDriver(registry)]]),
        function* () {
          return yield* withProgramDriverTestScope(authority, function* () {
            yield* LuaEvaluationPort.installDriver({
              *execute(command) {
                commands.push(command);
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
        elicitAudience: "user:reply",
      });
      expect((yield* advance(authority)).state).toBe("parked");
      const pending = authority
        .readJournal(attach.sessionId)
        .find(
          (record) =>
            record.payload.type === "PullRequested" && record.payload.descriptor.kind === "elicit",
        )?.payload;
      if (pending?.type !== "PullRequested") {
        throw new Error("Expected computation approval");
      }
      expect(JSON.stringify(pending)).toContain("This workflow needs more computation to finish");
      expect(
        commands.filter((command) => (command as { action: string }).action === "continue").length,
      ).toBeGreaterThan(0);
      return { snapshot: JSON.parse(JSON.stringify(authority.exportSnapshot())), pending };
    });
    await run(function* () {
      const authority = yield* createAuthorityScenarioDriver({
        ...options,
        snapshot: parked.snapshot,
      });
      commands.length = 0;
      expect((yield* advance(authority)).state).toBe("parked");
      // Accepted slice checkpoints are replayed from the journal, never recomputed.
      expect(
        commands.every((command) => (command as { action: string }).action === "validate"),
      ).toBe(true);
      const request = {
        capability: authority.resolutionCapability(
          attach.sessionId,
          parked.pending.taskId,
          parked.pending.pullId,
        ),
        audience: "user:reply",
        outcome: {
          status: "ok" as const,
          value: assertJson(action === "accept" ? { action, content: {} } : { action }),
        },
      };
      const resolution = yield* authority.resolve(request);
      expect(resolution.status, JSON.stringify(resolution)).not.toBe("rejected");
      yield* authority.resolve(request); // Retried click must not grant another allowance.
      const completed = yield* advance(authority);
      expect(completed.state).toBe("completed");
      if (completed.state === "completed") {
        expect(completed.value).toEqual(
          action === "accept" ? 1000 : { status: "cancelled", completedEffects: 0 },
        );
      }
      expect(
        authority
          .readJournal(attach.sessionId)
          .filter(
            (record) =>
              record.payload.type === "PullResolved" &&
              record.payload.pullId === parked.pending.pullId,
          ),
      ).toHaveLength(1);
    });
  },
);

it.each(["limit", "cancel", "error", "large", "driver-error"] as const)(
  "reports %s as a known tool result",
  async (scenario) => {
    const lua = createLuaTool([], {
      sliceFuel: scenario === "large" ? 100_000 : 500,
      maxFuel: scenario === "large" ? 2_000_000 : 8000,
      onExhausted: scenario === "cancel" ? "cancel" : "continue",
      allowanceFuel: scenario === "large" ? 1_000_000 : 2000,
    });
    const tools = [lua, computationApproval];
    const registry = createDurableToolRegistry(tools);
    const attach = {
      sessionId: "fuel-test",
      taskId: "turn-0/root",
      executionEpoch: 1,
      program: {
        id: lua.manifest.programId,
        version: lua.manifest.version,
        digest: lua.manifest.digest,
      },
      input: {
        program:
          scenario === "large"
            ? "local c = {} for i = 1, 9000 do c[i] = {i,i,i,i} end local sum = 0 for i = 1, 9000 do sum = sum + c[i][1] end return sum"
            : scenario === "error"
              ? 'error("actual cause")'
              : "while true do end",
      },
      route: { driverKind: "program" },
    };
    const options = {
      journalId: "fuel",
      journalIncarnation: "test",
      keyring: createCapabilityKeyring("fuel-tests", [
        { keyId: "test", secret: "fuel-test-secret-not-production-at-least-32-bytes" },
      ]),
      schemaRegistry: createDurableSchemaRegistry(
        tools.flatMap((tool) => [...tool.artifacts.catalog]),
      ),
    };
    const commands: unknown[] = [];
    function* advance(authority: AuthorityScenarioDriver) {
      return yield* ProgramDriverRegistryContext.with(
        createProgramDriverRegistry([["program", createWorkflowProgramDriver(registry)]]),
        function* () {
          return yield* withProgramDriverTestScope(authority, function* () {
            yield* LuaEvaluationPort.installDriver({
              *execute(command) {
                commands.push(command);
                if (
                  scenario === "driver-error" &&
                  (command as { action: string }).action !== "validate"
                ) {
                  throw new Error("evaluator failed with actual diagnostic");
                }
                return yield* invokeWasm(command);
              },
            });
            return yield* driveInstalledTestProgramTree({ attach });
          });
        },
      );
    }

    await run(function* () {
      const authority = yield* createAuthorityScenarioDriver(options);
      yield* authority.openTask({
        ...attach,
        turnId: "turn-0",
        manifest: lua.manifest,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
        elicitAudience: "user:reply",
      });
      const result = yield* advance(authority);
      expect(result.state).toBe("completed");
      if (result.state === "completed") {
        if (scenario === "large") {
          expect(result.value).toBe(40_504_500);
          expect(commands.some((command) => JSON.stringify(command).length > 1024 * 1024)).toBe(
            true,
          );
        }
        if (scenario === "driver-error") {
          expect(result.value).toMatchObject({
            status: "failed",
            diagnostic: {
              message: expect.stringContaining("evaluator failed with actual diagnostic"),
            },
          });
        }
        if (scenario === "limit") {
          expect(result.value).toMatchObject({
            status: "failed",
            diagnostic: { code: "execution_budget_exceeded" },
          });
        }
        if (scenario === "cancel") {
          expect(result.value).toMatchObject({ status: "cancelled" });
        }
        if (scenario === "error") {
          expect(result.value).toMatchObject({
            status: "failed",
            diagnostic: { message: expect.stringContaining("actual cause") },
          });
        }
      }
      expect(
        authority
          .readJournal(attach.sessionId)
          .some(
            (record) =>
              record.payload.type === "PullRequested" &&
              record.payload.descriptor.kind === "elicit",
          ),
      ).toBe(false);
    });
  },
);
