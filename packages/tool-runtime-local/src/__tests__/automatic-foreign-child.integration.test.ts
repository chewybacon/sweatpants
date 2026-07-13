import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/core";
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
  type ProgramRunResult,
} from "@sweatpants/session-contract";

import {
  createInMemoryToolSessionStore,
  createLocalDurableProgramDriver,
  createToolSessionForeignEffectRegistrations,
  createToolSessionRegistry,
} from "../index.ts";

type Result = { answers: string[] };
type Choice = { answer: string; continue: boolean };

const parentManifest = defineDurableProgramManifest<null, Result>({
  programId: "fixture.automatic-foreign-parent",
  version: "1.0.0",
  digest: "3".repeat(64),
  inputSchema: { type: "null" },
  outputSchema: {
    type: "object",
    required: ["answers"],
    properties: { answers: { type: "array", items: { type: "string" } } },
    additionalProperties: false,
  },
  elicits: {},
  effects: {},
  capabilities: {
    durableEmissions: false,
    structuredChildren: true,
    replay: "strict",
  },
});

describe("automatic foreign adapter child orchestration", () => {
  it("runs an unchanged multi-turn sampling and eliciting tool without host-side child coordination", async () => {
    let toolExecutions = 0;
    let durableSamples = 0;
    const tool = createTool("automatic_foreign_tool")
      .description("An unchanged ordinary authored tool")
      .parameters(z.object({ topic: z.string() }))
      .elicits({
        choose: {
          response: z.object({ answer: z.string(), continue: z.boolean() }),
          context: z.object({ round: z.number(), suggestion: z.string() }),
        },
      })
      .samples()
      .execute(function* ({ topic }, context) {
        toolExecutions += 1;
        const answers: string[] = [];
        for (let round = 0; round < 2; round += 1) {
          const sample = yield* context.sample({ prompt: `${topic}:${round}` });
          const response = yield* context.elicit("choose", {
            message: sample.text,
            context: { round, suggestion: sample.text },
          });
          if (response.action !== "accept") {
            break;
          }
          answers.push(response.content.answer);
          if (!response.content.continue) {
            break;
          }
        }
        return { answers };
      });
    const request: ForeignToolRequest = {
      driver: "tool-session",
      tool: tool.name,
      input: { topic: "durability" },
      durability: "ephemeral_handle",
    };
    const parent = createDurableTool(parentManifest, function* (_input, context) {
      return yield* context.foreignTool<Result>(request);
    });
    const tools = createDurableToolRegistry([parent, foreignToolAdapter]);
    const drivers = createProgramDriverRegistry([
      ["generator", createLocalDurableProgramDriver(tools)],
    ]);
    const keyring = createCapabilityKeyring("automatic-child", [
      { keyId: "active", secret: "automatic-child-secret-is-32bytes" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "automatic-child",
      journalIncarnation: "1",
      keyring,
    });
    const sessionId = "automatic-child-session";
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
            throw new Error("ToolSession sampling must be lifted into the outer crank");
          },
        },
      });
      const effects = createDurableEffectRegistry([
        ...createToolSessionForeignEffectRegistrations({
          registry,
          tools: new Map<string, RuntimeTool>([[tool.name, tool]]),
        }),
        foreignToolAdapter.modelSampleRegistration(function* () {
          const round = durableSamples;
          durableSamples += 1;
          return { text: `suggestion-${round}` };
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
        answer: "answer-0",
        continue: true,
      });
      authority = recreate(authority, keyring);

      expect(yield* runProgram(attach, authority, drivers, effects)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      authority = recreate(authority, keyring);
      yield* acceptPending(authority, sessionId, childTaskId, {
        answer: "answer-1",
        continue: false,
      });
      authority = recreate(authority, keyring);

      expect(yield* runProgram(attach, authority, drivers, effects)).toEqual({
        state: "completed",
        value: { answers: ["answer-0", "answer-1"] },
      });
      const journal = authority.readJournal(sessionId);
      expect(countEffectPulls(journal, "foreign.tool.start")).toBe(1);
      expect(countEffectPulls(journal, "foreign.tool.continue")).toBe(4);
      expect(countEffectPulls(journal, "model.sample")).toBe(2);
      expect(
        journal.some(
          (record) => record.payload.type === "TaskOpened" && record.payload.taskId === childTaskId,
        ),
      ).toBe(true);
      const childClose = journal.findIndex(
        (record) => record.payload.type === "TaskClosed" && record.payload.taskId === childTaskId,
      );
      const parentResolution = journal.findIndex(
        (record) => record.payload.type === "PullResolved" && record.payload.taskId === taskId,
      );
      expect(childClose).toBeLessThan(parentResolution);
      expect(journal.at(-1)?.payload).toMatchObject({
        type: "TaskClosed",
        taskId,
        outcome: { status: "ok", value: { answers: ["answer-0", "answer-1"] } },
      });
    });

    expect(toolExecutions).toBe(1);
    expect(durableSamples).toBe(2);
  });
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
    journalId: "automatic-child",
    journalIncarnation: "1",
    keyring,
    snapshot: authority.exportSnapshot(),
  });
}

function* acceptPending(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  sessionId: string,
  taskId: string,
  content: Choice,
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
    throw new Error("Missing pending foreign elicitation");
  }
  const result = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, taskId, request.payload.pullId),
    audience: "user:foreign_input",
    outcome: { status: "ok", value: { action: "accept", content } },
  });
  if (result.status === "rejected") {
    throw new Error(result.code);
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
