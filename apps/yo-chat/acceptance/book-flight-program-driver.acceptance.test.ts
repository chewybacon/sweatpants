import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import type { RuntimeTool } from "@sweatpants/core";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
  defineDurableProgramManifest,
  foreignToolAdapter,
  type AttachProgramRequest,
  type DurableSemanticRecord,
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

import { bookFlightTool, type BookFlightResult } from "../src/tools/book-flight/tool.ts";

const parentManifest = defineDurableProgramManifest<null, Json>({
  programId: "acceptance.book-flight-parent",
  version: "1.0.0",
  digest: "5".repeat(64),
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

describe("unchanged book_flight through ProgramRuntime", () => {
  it("completes the existing authored multi-turn tool without tool.execute/tool.resume", async () => {
    let modelSamples = 0;
    const foreignRequest: ForeignToolRequest = {
      driver: "tool-session",
      tool: bookFlightTool.name,
      input: { from: "NYC", destination: "LAX" },
      durability: "ephemeral_handle",
    };
    const parent = createDurableTool(parentManifest, function* (_input, context) {
      return yield* context.foreignTool<Json>(foreignRequest);
    });
    const tools = createDurableToolRegistry([parent, foreignToolAdapter]);
    const drivers = createProgramDriverRegistry([
      ["generator", createLocalDurableProgramDriver(tools)],
    ]);
    const keyring = createCapabilityKeyring("book-flight-program-driver", [
      { keyId: "active", secret: "book-flight-program-driver-key!!" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "book-flight-program-driver",
      journalIncarnation: "1",
      keyring,
    });
    const sessionId = "book-flight-program-driver-session";
    const taskId = "turn-0/root";
    const childTaskId = `${taskId}.0`;
    const attach: AttachProgramRequest = {
      sessionId,
      taskId,
      program: {
        id: parentManifest.programId,
        version: parentManifest.version,
        digest: parentManifest.digest,
      },
      input: null,
      route: { driverKind: "generator" },
      executionEpoch: 1,
    };

    await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
        samplingProvider: {
          *sample(): Operation<never> {
            throw new Error("ToolSession sampling must be lifted into ProgramRuntime");
          },
        },
      });
      const effects = createDurableEffectRegistry([
        ...createToolSessionForeignEffectRegistrations({
          registry,
          tools: new Map<string, RuntimeTool>([[bookFlightTool.name, bookFlightTool]]),
        }),
        foreignToolAdapter.modelSampleRegistration(function* () {
          modelSamples += 1;
          return { text: "Travel light and arrive early.", calls: [], content: [] };
        }),
      ]);
      yield* authority.openTask({
        sessionId,
        turnId: "turn-0",
        taskId,
        manifest: parentManifest,
        input: null,
        executionEpoch: 1,
        attachmentId: "unattached-parent",
        audience: "program-runtime",
      });

      expect(yield* runProgram(attach, authority, drivers, effects)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      authority = recreate(authority, keyring);
      yield* acceptPending(authority, sessionId, childTaskId, {
        action: "accept",
        content: { flightId: "FL001" },
      });
      authority = recreate(authority, keyring);

      expect(yield* runProgram(attach, authority, drivers, effects)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      authority = recreate(authority, keyring);
      yield* acceptPending(authority, sessionId, childTaskId, {
        action: "accept",
        content: { row: 2, seat: "A" },
      });
      authority = recreate(authority, keyring);

      const completed = yield* runProgram(attach, authority, drivers, effects);
      expect(completed.state).toBe("completed");
      if (completed.state !== "completed") {
        throw new Error("book_flight did not complete");
      }
      const result = completed.value as BookFlightResult;
      expect(result).toMatchObject({
        success: true,
        flight: { id: "FL001", airline: "SkyHigh Airways", flightNumber: "SH 142" },
        seat: "2A",
        route: { from: "NYC", to: "LAX" },
        travelTip: "Travel light and arrive early.",
      });
      if (result.success) {
        expect(result.ticketNumber).toMatch(/^TKT-[A-Z0-9]{8}$/);
      }

      const journal = authority.readJournal(sessionId);
      expect(countEffectPulls(journal, "foreign.tool.start")).toBe(1);
      expect(countEffectPulls(journal, "foreign.tool.continue")).toBe(3);
      expect(countEffectPulls(journal, "model.sample")).toBe(1);
      expect(countEffectPulls(journal, "tool.execute")).toBe(0);
      expect(countEffectPulls(journal, "tool.resume")).toBe(0);
      expect(countElicits(journal, childTaskId)).toBe(2);
      expect(journal.at(-1)?.payload).toMatchObject({
        type: "TaskClosed",
        taskId,
        outcome: { status: "ok" },
      });
    });

    expect(modelSamples).toBe(1);
  }, 15_000);
});

function runProgram(
  attach: AttachProgramRequest,
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  drivers: ReturnType<typeof createProgramDriverRegistry>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
): Operation<ProgramRunResult> {
  return ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
      });
    });
  });
}

function recreate(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  keyring: ReturnType<typeof createCapabilityKeyring>,
) {
  return createInMemoryDurableJournalAuthority({
    journalId: "book-flight-program-driver",
    journalIncarnation: "1",
    keyring,
    snapshot: authority.exportSnapshot(),
  });
}

function* acceptPending(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  sessionId: string,
  taskId: string,
  value: Json,
): Operation<void> {
  const journal = authority.readJournal(sessionId);
  const resolved = new Set(
    journal.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  const request = journal.find(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.taskId === taskId &&
      record.payload.descriptor.kind === "elicit" &&
      !resolved.has(record.payload.pullId),
  );
  if (!request || request.payload.type !== "PullRequested") {
    throw new Error("Missing book_flight elicitation");
  }
  const resolution = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, taskId, request.payload.pullId),
    audience: "user:foreign_input",
    outcome: { status: "ok", value },
  });
  if (resolution.status === "rejected") {
    throw new Error(resolution.code);
  }
}

function countEffectPulls(records: DurableSemanticRecord[], name: string): number {
  return records.filter(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.descriptor.kind === "effect" &&
      record.payload.descriptor.name === name,
  ).length;
}

function countElicits(records: DurableSemanticRecord[], taskId: string): number {
  return records.filter(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.taskId === taskId &&
      record.payload.descriptor.kind === "elicit",
  ).length;
}
