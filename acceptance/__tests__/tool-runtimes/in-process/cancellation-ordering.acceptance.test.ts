// @vitest-environment node
import { action, createQueue, run, scoped, spawn, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/agent-sdk";
import {
  createCapabilityKeyring,
  createWorkflowProgramDriver,
} from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  type AuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
  ANY_JSON_SCHEMA_DESCRIPTOR,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  defineDurableProgramManifest,
  type AttachProgramRequest,
  type EphemeralToolRequest,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  EPHEMERAL_TOOL_ADAPTER_PROGRAM,
  ephemeralToolAdapter,
  ephemeralToolSchemaEntries,
} from "@sweatpants/tool-session/ephemeral";
import { createLocalToolInvocationRuntime } from "@sweatpants/tool-runtime-local";
import { createToolInvocationEphemeralEffectRegistrations } from "@sweatpants/tool-session/execution";

const parentManifest = defineDurableProgramManifest<null, Json>({
  programId: "acceptance.abort-signal-parent",
  version: "1.0.0",
  digest: "9".repeat(64),
  inputSchema: NULL_RESULT_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: {
    durableEmissions: false,
    structuredChildren: true,
    replay: "strict",
  },
});

describe("durable cancellation reaches an ordinary createTool AbortSignal", () => {
  it("aborts the scope-owned signal while cancelling the ephemeral child leaves-first", async () => {
    return await run(function* () {
      // Arrange: an ordinary authored tool waits on its scope-owned signal.
      const toolStarted = createQueue<void, void>();
      let invocationSignal: AbortSignal | undefined;
      let signalAbortCount = 0;
      let bodyContinuedAfterAbort = false;

      const abortAwareTool = createTool("abort_aware_ephemeral_tool")
        .description("Wait until its ordinary invocation is cancelled")
        .parameters(z.object({ label: z.string() }))
        .execute(function* ({ label }, context) {
          invocationSignal = context.signal;
          expect(context.signal).toBeInstanceOf(AbortSignal);
          expect(context.signal.aborted).toBe(false);
          toolStarted.add(undefined);
          yield* action<void>((resolve) => {
            if (context.signal.aborted) {
              resolve();
              return () => {};
            }
            const onAbort = () => {
              signalAbortCount += 1;
              resolve();
            };
            context.signal.addEventListener("abort", onAbort, { once: true });
            return () => context.signal.removeEventListener("abort", onAbort);
          });
          bodyContinuedAfterAbort = true;
          return { label, observedAbort: context.signal.aborted };
        });
      const ephemeralRequest: EphemeralToolRequest = {
        driver: "tool-session",
        tool: abortAwareTool.name,
        input: { label: "cancel-me" },
        durability: "ephemeral_handle",
        route: "call-abort-aware",
      };
      const parent = createPinnedDurableProgram(parentManifest, function* (_input, context) {
        return yield* context.pull(
          assertJson({
            kind: "invoke",
            child: { ...EPHEMERAL_TOOL_ADAPTER_PROGRAM, input: ephemeralRequest },
          }),
        );
      });
      const tools = createDurableToolRegistry([parent, ephemeralToolAdapter]);
      const drivers = createProgramDriverRegistry([
        ["program", createWorkflowProgramDriver(tools)],
      ]);
      const keyring = createCapabilityKeyring("abort-signal-acceptance", [
        { keyId: "active", secret: "abort-signal-acceptance-key-32-bytes" },
      ]);
      const authority = yield* createAuthorityScenarioDriver({
        journalId: "abort-signal-acceptance",
        journalIncarnation: "1",
        keyring,
        schemaRegistry: createDurableSchemaRegistry(ephemeralToolSchemaEntries()),
      });
      const sessionId = "abort-signal-acceptance-session";
      const parentTaskId = "turn-0/root";
      const childTaskId = `${parentTaskId}.0`;
      const attach: AttachProgramRequest = {
        sessionId,
        taskId: parentTaskId,
        program: {
          id: parentManifest.programId,
          version: parentManifest.version,
          digest: parentManifest.digest,
        },
        input: null,
        route: { driverKind: "program" },
        executionEpoch: 1,
      };

      yield* scoped(function* () {
        yield* createLocalToolInvocationRuntime({});
        const effects = createDurableEffectRegistry([
          ...createToolInvocationEphemeralEffectRegistrations({
            tools: new Map<string, RuntimeTool>([[abortAwareTool.name, abortAwareTool]]),
          }),
        ]);
        yield* authority.openTask({
          sessionId,
          turnId: "turn-0",
          taskId: parentTaskId,
          manifest: parentManifest,
          input: null,
          executionEpoch: 1,
          attachmentId: "unattached-parent",
          audience: "workflow-host",
        });

        const activation = yield* spawn(function* () {
          return yield* runProgram(attach, authority, drivers, effects);
        });
        yield* toolStarted.next();
        expect(invocationSignal?.aborted).toBe(false);

        // Act: cancel the durable parent while its ordinary child is running.
        const accepted = yield* authority.requestCancellation(
          sessionId,
          parentTaskId,
          "acceptance-test-cancellation",
          "cancel-abort-aware-tool",
        );
        expect(accepted).toMatchObject({ accepted: true, duplicate: false });
        expect(yield* activation).toEqual({ state: "cancelled" });
      });

      // Assert: abort fires once and cancellation settles children before their parent.
      expect(invocationSignal?.aborted).toBe(true);
      expect(signalAbortCount).toBe(1);
      expect(bodyContinuedAfterAbort).toBe(false);

      const journal = authority.readJournal(sessionId);
      const childClose = journal.findIndex(
        (record) => record.payload.type === "TaskClosed" && record.payload.taskId === childTaskId,
      );
      const parentResolution = journal.findIndex(
        (record) =>
          record.payload.type === "PullResolved" && record.payload.taskId === parentTaskId,
      );
      const parentClose = journal.findIndex(
        (record) => record.payload.type === "TaskClosed" && record.payload.taskId === parentTaskId,
      );
      expect(childClose).toBeGreaterThan(-1);
      expect(childClose).toBeLessThan(parentResolution);
      expect(parentResolution).toBeLessThan(parentClose);
      expect(journal[childClose]?.payload).toMatchObject({
        type: "TaskClosed",
        taskId: childTaskId,
        outcome: { status: "cancelled" },
      });
      expect(journal[parentClose]?.payload).toMatchObject({
        type: "TaskClosed",
        taskId: parentTaskId,
        outcome: { status: "cancelled" },
      });
    });
  }, 10_000);
});

function runProgram(
  attach: AttachProgramRequest,
  authority: AuthorityScenarioDriver,
  drivers: ReturnType<typeof createProgramDriverRegistry>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
): Operation<AdvancementResult> {
  return ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* withProgramDriverTestScope(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* driveInstalledTestProgramTree({ attach });
      });
    });
  });
}
