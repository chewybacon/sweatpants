import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
// @vitest-environment node
import { action, createQueue, run, spawn, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/core";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  DurableEffectRegistryContext,
  withJournalAuthority,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  defineDurableProgramManifest,
  foreignToolAdapter,
  type AttachProgramRequest,
  type ForeignToolRequest,
  type Json,
  type ProgramRunResult,
} from "@sweatpants/session-contract";
import {
  createInMemoryToolSessionStore,
  createLocalDurableProgramDriver,
  createToolSessionForeignEffectRegistrations,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";

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
  it("aborts the scope-owned signal while cancelling the foreign child leaves-first", async () => {
    const toolStarted = createQueue<void, void>();
    let invocationSignal: AbortSignal | undefined;
    let signalAbortCount = 0;
    let bodyContinuedAfterAbort = false;

    const abortAwareTool = createTool("abort_aware_foreign_tool")
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
            return;
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
    const foreignRequest: ForeignToolRequest = {
      driver: "tool-session",
      tool: abortAwareTool.name,
      input: { label: "cancel-me" },
      durability: "ephemeral_handle",
      route: "call-abort-aware",
    };
    const parent = createPinnedDurableProgram(parentManifest, function* (_input, context) {
      return yield* context.foreignTool<Json>(foreignRequest);
    });
    const tools = createDurableToolRegistry([parent, foreignToolAdapter]);
    const drivers = createProgramDriverRegistry([
      ["program", createLocalDurableProgramDriver(tools)],
    ]);
    const keyring = createCapabilityKeyring("abort-signal-acceptance", [
      { keyId: "active", secret: "abort-signal-acceptance-key-32-bytes" },
    ]);
    const authority = createInMemoryDurableJournalAuthority({
      journalId: "abort-signal-acceptance",
      journalIncarnation: "1",
      keyring,
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

    await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {});
      const effects = createDurableEffectRegistry([
        ...createToolSessionForeignEffectRegistrations({
          registry,
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
        audience: "program-runtime",
      });

      const activation = yield* spawn(function* () {
        return yield* runProgram(attach, authority, drivers, effects);
      });
      yield* toolStarted.next();
      expect(invocationSignal?.aborted).toBe(false);

      const accepted = yield* authority.requestCancellation(
        sessionId,
        parentTaskId,
        "acceptance-test-cancellation",
        "cancel-abort-aware-tool",
      );
      expect(accepted).toMatchObject({ accepted: true, duplicate: false });
      expect(yield* activation).toEqual({ state: "cancelled" });
    });

    expect(invocationSignal?.aborted).toBe(true);
    expect(signalAbortCount).toBe(1);
    expect(bodyContinuedAfterAbort).toBe(false);

    const journal = authority.readJournal(sessionId);
    const childClose = journal.findIndex(
      (record) => record.payload.type === "TaskClosed" && record.payload.taskId === childTaskId,
    );
    const parentResolution = journal.findIndex(
      (record) => record.payload.type === "PullResolved" && record.payload.taskId === parentTaskId,
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
  }, 10_000);
});

function runProgram(
  attach: AttachProgramRequest,
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  drivers: ReturnType<typeof createProgramDriverRegistry>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
): Operation<ProgramRunResult> {
  return ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* withJournalAuthority(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
      });
    });
  });
}
