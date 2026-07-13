import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import type { RuntimeTool } from "@sweatpants/core";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
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

import { playTttTool, type PlayTttResult } from "../src/tools/play-ttt/tool.ts";

const parentManifest = defineDurableProgramManifest<null, Json>({
  programId: "acceptance.play-ttt-parent",
  version: "1.0.0",
  digest: "6".repeat(64),
  inputSchema: { type: "null" },
  outputSchema: true,
  elicits: {},
  effects: {},
  capabilities: {
    durableEmissions: false,
    structuredChildren: true,
    replay: "strict",
  },
});

describe("unchanged play_ttt through ProgramRuntime", () => {
  it("completes the existing authored sample/elicit loop without legacy tool effects", async () => {
    let modelSamples = 0;
    let userResponses = 0;
    const request: ForeignToolRequest = {
      driver: "tool-session",
      tool: playTttTool.name,
      input: {},
      durability: "ephemeral_handle",
    };
    const parent = createDurableTool(parentManifest, function* (_input, context) {
      return yield* context.foreignTool<Json>(request);
    });
    const tools = createDurableToolRegistry([parent, foreignToolAdapter]);
    const drivers = createProgramDriverRegistry([
      ["generator", createLocalDurableProgramDriver(tools)],
    ]);
    const keyring = createCapabilityKeyring("play-ttt-program-driver", [
      { keyId: "active", secret: "play-ttt-program-driver-key-32!!" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "play-ttt-program-driver",
      journalIncarnation: "1",
      keyring,
    });
    const sessionId = "play-ttt-program-driver-session";
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
          tools: new Map<string, RuntimeTool>([[playTttTool.name, playTttTool]]),
        }),
        foreignToolAdapter.modelSampleRegistration(function* (sampleRequest) {
          modelSamples += 1;
          return sampleResponse(sampleRequest, modelSamples);
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

      let completed: ProgramRunResult | undefined;
      for (let round = 0; round < 12; round += 1) {
        const outcome = yield* runProgram(attach, authority, drivers, effects);
        if (outcome.state !== "parked") {
          completed = outcome;
          break;
        }
        expect(outcome.reason).toBe("elicit");
        authority = recreate(authority, keyring);
        const position = responsePosition(authority.readJournal(sessionId), childTaskId);
        yield* acceptPending(authority, sessionId, childTaskId, { position });
        userResponses += 1;
        authority = recreate(authority, keyring);
      }

      if (completed?.state !== "completed") {
        throw new Error(`play_ttt did not complete: ${JSON.stringify(completed)}`);
      }
      expect(completed.state).toBe("completed");
      const result = completed.value as PlayTttResult;
      expect(result).toMatchObject({ success: true });

      const journal = authority.readJournal(sessionId);
      expect(countEffectPulls(journal, "foreign.tool.start")).toBe(1);
      expect(countEffectPulls(journal, "foreign.tool.continue")).toBeGreaterThan(1);
      expect(countEffectPulls(journal, "model.sample")).toBe(modelSamples);
      expect(countEffectPulls(journal, "tool.execute")).toBe(0);
      expect(countEffectPulls(journal, "tool.resume")).toBe(0);
      expect(countElicits(journal, childTaskId)).toBe(userResponses);
      expect(journal.at(-1)?.payload).toMatchObject({
        type: "TaskClosed",
        taskId,
        outcome: { status: "ok" },
      });
    });

    expect(modelSamples).toBeGreaterThan(1);
    expect(userResponses).toBeGreaterThan(0);
  }, 20_000);
});

function sampleResponse(request: Json, sequence: number): Json {
  if (
    request !== null &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    request["schema"] !== undefined
  ) {
    const parsed = { cell: firstEmptyPosition(request) };
    return {
      text: JSON.stringify(parsed),
      parsed,
    };
  }
  return {
    text: "",
    stopReason: "toolUse",
    toolCalls: [
      {
        id: `strategy-${sequence}`,
        name: "play_offensive",
        arguments: { reasoning: "Use the first available position" },
      },
    ],
  };
}

function firstEmptyPosition(request: Json): number {
  const serialized = JSON.stringify(request);
  const match = /Empty positions:\s*([0-8](?:,\s*[0-8])*)/.exec(serialized);
  if (!match?.[1]) {
    return 0;
  }
  const first = Number(match[1].split(",")[0]);
  return Number.isInteger(first) ? first : 0;
}

function responsePosition(records: DurableSemanticRecord[], taskId: string): number {
  const request = pendingElicit(records, taskId);
  const context =
    request.payload.descriptor.kind === "elicit" ? request.payload.descriptor.context : undefined;
  if (containsGameOver(context)) {
    return -1;
  }
  const board = findBoard(context);
  const empty = board?.findIndex((cell) => cell === null) ?? 0;
  return empty >= 0 ? empty : -1;
}

function containsGameOver(value: Json | undefined): boolean {
  if (value === true) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsGameOver);
  }
  if (value && typeof value === "object") {
    if (value["gameOver"] === true) {
      return true;
    }
    return Object.values(value).some(containsGameOver);
  }
  return false;
}

function findBoard(value: Json | undefined): Json[] | undefined {
  if (Array.isArray(value)) {
    if (
      value.length === 9 &&
      value.every((cell) => cell === null || cell === "X" || cell === "O")
    ) {
      return value;
    }
    for (const child of value) {
      const board = findBoard(child);
      if (board) {
        return board;
      }
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const board = findBoard(child);
      if (board) {
        return board;
      }
    }
  }
  return undefined;
}

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
    journalId: "play-ttt-program-driver",
    journalIncarnation: "1",
    keyring,
    snapshot: authority.exportSnapshot(),
  });
}

function pendingElicit(records: DurableSemanticRecord[], taskId: string) {
  const resolved = new Set(
    records.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  const request = records.find(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.taskId === taskId &&
      record.payload.descriptor.kind === "elicit" &&
      !resolved.has(record.payload.pullId),
  );
  if (!request || request.payload.type !== "PullRequested") {
    throw new Error("Missing play_ttt elicitation");
  }
  return request;
}

function* acceptPending(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  sessionId: string,
  taskId: string,
  content: Json,
): Operation<void> {
  const request = pendingElicit(authority.readJournal(sessionId), taskId);
  const resolution = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, taskId, request.payload.pullId),
    audience: "user:foreign_input",
    outcome: { status: "ok", value: { action: "accept", content } },
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
