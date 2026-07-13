import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/core";
import {
  DurableEffectRegistryContext,
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
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

describe("ToolSession foreign-tool durability boundary", () => {
  it("fails without restarting when an ephemeral ToolSession host disappears", async () => {
    let toolBodyExecutions = 0;
    let foreignStarts = 0;
    const tool = createTool("lost_foreign_tool")
      .description("A foreign tool whose live host will disappear")
      .parameters(z.object({ topic: z.string() }))
      .elicits({
        choose: {
          response: z.object({ answer: z.string() }),
          context: z.object({ suggestion: z.string() }),
        },
      })
      .samples()
      .execute(function* ({ topic }, context) {
        toolBodyExecutions += 1;
        const sample = yield* context.sample({ prompt: `Suggest ${topic}` });
        const response = yield* context.elicit("choose", {
          message: sample.text,
          context: { suggestion: sample.text },
        });
        return {
          answer: response.action === "accept" ? response.content.answer : "none",
        };
      });
    const request: ForeignToolRequest = {
      driver: "tool-session",
      tool: tool.name,
      input: { topic: "durability" },
      durability: "ephemeral_handle",
    };
    const tools = createDurableToolRegistry([foreignToolAdapter]);
    const drivers = createProgramDriverRegistry([
      ["generator", createLocalDurableProgramDriver(tools)],
    ]);
    const keyring = createCapabilityKeyring("foreign-loss", [
      { keyId: "active", secret: "foreign-loss-secret-is-32-bytes!!" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "foreign-loss",
      journalIncarnation: "1",
      keyring,
    });
    const sessionId = "foreign-loss-session";
    const taskId = "turn-0/root";
    const attach = attachRequest(sessionId, taskId, request);

    const firstRun = await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
        samplingProvider: {
          *sample(): Operation<never> {
            throw new Error("Sampling must be journaled by the durable adapter");
          },
        },
      });
      const registrations = createToolSessionForeignEffectRegistrations({
        registry,
        tools: new Map<string, RuntimeTool>([[tool.name, tool]]),
      });
      const [startRegistration] = registrations;
      const effects = createDurableEffectRegistry([
        {
          ...startRegistration,
          handler(input, context) {
            foreignStarts += 1;
            return startRegistration.handler(input, context);
          },
        },
        ...registrations.slice(1),
        foreignToolAdapter.modelSampleRegistration(function* () {
          return { text: "suggestion-0" };
        }),
      ]);
      yield* authority.openTask({
        sessionId,
        turnId: "turn-0",
        taskId,
        manifest: FOREIGN_TOOL_ADAPTER_MANIFEST,
        input: request,
        executionEpoch: 1,
        attachmentId: "unattached-adapter",
        audience: "program-runtime",
      });
      return yield* runProgram(attach, authority, drivers, effects);
    });
    expect(firstRun).toMatchObject({ state: "parked", reason: "elicit" });

    authority = recreate(authority, keyring);
    await run(() => acceptPending(authority, sessionId, taskId));
    authority = recreate(authority, keyring);

    const recovered = await run(function* () {
      const replacementRegistry = yield* createToolSessionRegistry(
        createInMemoryToolSessionStore(),
        {
          samplingProvider: {
            *sample(): Operation<never> {
              throw new Error("Sampling must not restart after host loss");
            },
          },
        },
      );
      const effects = createDurableEffectRegistry([
        ...createToolSessionForeignEffectRegistrations({
          registry: replacementRegistry,
          tools: new Map<string, RuntimeTool>([[tool.name, tool]]),
        }),
        foreignToolAdapter.modelSampleRegistration(function* () {
          throw new Error("Recorded sampling must replay after host loss");
        }),
      ]);
      return yield* runProgram(attach, authority, drivers, effects);
    });

    expect(recovered).toMatchObject({
      state: "failed",
      error: { code: "foreign_continuation_lost" },
    });
    const journal = authority.readJournal(sessionId);
    expect(countEffectPulls(journal, "foreign.tool.start")).toBe(1);
    expect(countEffectPulls(journal, "foreign.tool.continue")).toBe(2);
    expect(countEffectPulls(journal, "model.sample")).toBe(1);
    expect(foreignStarts).toBe(1);
    expect(toolBodyExecutions).toBe(1);
  });
});

function attachRequest(
  sessionId: string,
  taskId: string,
  input: ForeignToolRequest,
): AttachProgramRequest {
  return {
    sessionId,
    taskId,
    program: {
      id: FOREIGN_TOOL_ADAPTER_MANIFEST.programId,
      version: FOREIGN_TOOL_ADAPTER_MANIFEST.version,
      digest: FOREIGN_TOOL_ADAPTER_MANIFEST.digest,
    },
    input,
    route: { driverKind: "generator" },
    executionEpoch: 1,
  };
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
    journalId: "foreign-loss",
    journalIncarnation: "1",
    keyring,
    snapshot: authority.exportSnapshot(),
  });
}

function* acceptPending(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  sessionId: string,
  taskId: string,
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
    throw new Error("Missing foreign elicitation");
  }
  const result = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, taskId, request.payload.pullId),
    audience: "user:foreign_input",
    outcome: {
      status: "ok",
      value: { action: "accept", content: { answer: "answer-after-loss" } },
    },
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
