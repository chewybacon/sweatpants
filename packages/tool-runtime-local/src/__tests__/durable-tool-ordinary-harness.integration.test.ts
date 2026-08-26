import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import { assertJson } from "@sweatpants/foundation";
import { foreignToolSchemaEntries } from "@sweatpants/tool-session/foreign";

import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { createCapabilityKeyring, type DurableSemanticRecord } from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  defineDurableProgramManifest,
  type AttachProgramRequest,
  type ForeignToolRequest,
  type ProgramElicitResult,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import {
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  foreignToolAdapter,
} from "@sweatpants/tool-session/foreign";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { anyGuard, createSchemaFixture } from "@sweatpants/journal-authority/testing";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import { withModelSampleTestBoundary } from "./model-sample-test-boundary.ts";

import {
  createLocalToolInvocationRuntime,
  createDurableToolSessionFacade,
  createInMemoryDurableToolFacadeStateStore,
  createToolInvocationForeignEffectRegistrations,
} from "../index.ts";

type InnerInput = { topic: string };
type InnerOutput = { answers: string[] };
type Choice = { answer: string; continue: boolean };

const sampleInput = createSchemaFixture(
  "ordinary-harness/sample-input",
  "pull_input",
  true,
  anyGuard,
);
const sampleOutput = createSchemaFixture(
  "ordinary-harness/sample-output",
  "pull_output",
  true,
  anyGuard,
);
const choiceSchema = createSchemaFixture(
  "ordinary-harness/choice",
  "elicit_response",
  {
    type: "object",
    required: ["answer", "continue"],
    properties: {
      answer: { type: "string" },
      continue: { type: "boolean" },
    },
    additionalProperties: false,
  },
  anyGuard,
);
const innerInput = createSchemaFixture(
  "ordinary-harness/inner-input",
  "program_input",
  true,
  anyGuard,
);
const innerOutput = createSchemaFixture(
  "ordinary-harness/inner-output",
  "program_output",
  true,
  anyGuard,
);
const innerSchemas = () =>
  createDurableSchemaRegistry([
    ...foreignToolSchemaEntries(),
    sampleInput.entry,
    sampleOutput.entry,
    choiceSchema.entry,
    innerInput.entry,
    innerOutput.entry,
  ]);

const innerManifest = defineDurableProgramManifest<InnerInput, InnerOutput>({
  programId: "fixture.inner-durable-behind-ordinary-harness",
  version: "1.0.0",
  digest: "4".repeat(64),
  inputSchema: innerInput.descriptor,
  outputSchema: innerOutput.descriptor,
  elicits: {
    choice: { response: choiceSchema.descriptor },
  },
  effects: {},
  pulls: { sample: { input: sampleInput.descriptor, output: sampleOutput.descriptor } },
  capabilities: {
    durableEmissions: false,
    structuredChildren: false,
    replay: "strict",
  },
});

describe("durable tool behind an ordinary ToolSession harness", () => {
  it("recreates its inner crank runtime across multi-turn sample and elicit rounds without extension support", async () => {
    let innerFactories = 0;
    let innerActivations = 0;
    let outerModelSamples = 0;
    const innerTool = createPinnedDurableProgram(innerManifest, function* ({ topic }, context) {
      innerFactories += 1;
      const answers: string[] = [];
      for (let round = 0; round < 2; round += 1) {
        // Native workflow sampling boundary: journals the request and parks
        // until the owning session resolves it (Decision 3 semantics).
        const sampled = (yield* context.pull(
          assertJson({
            kind: "sample",
            input: { prompt: `Suggest ${topic}, round ${round}` },
          }),
        )) as { text: string };
        const result = (yield* context.pull(
          assertJson({
            kind: "elicit",
            key: "choice",
            message: sampled.text,
            response: choiceSchema.descriptor,
          }),
        )) as ProgramElicitResult<Choice>;
        if (result.action !== "accept") {
          break;
        }
        answers.push(result.content.answer);
        if (!result.content.continue) {
          break;
        }
      }
      return { answers };
    });

    const stateStore = createInMemoryDurableToolFacadeStateStore();
    const keyring = createCapabilityKeyring("ordinary-harness-inner", [
      { keyId: "active", secret: "ordinary-harness-inner-key-32bytes" },
    ]);
    const facade = createDurableToolSessionFacade({
      tool: innerTool,
      stateStore,
      keyring,
      name: "ordinary_durable_tool",
      schemaRegistry: innerSchemas(),
      onActivation: function* () {
        innerActivations += 1;
      },
    });
    const request: ForeignToolRequest = {
      driver: "tool-session",
      tool: facade.name,
      input: { topic: "durability" },
      durability: "ephemeral_handle",
    };
    const adapterTools = createDurableToolRegistry([foreignToolAdapter]);
    const drivers = createProgramDriverRegistry([
      ["program", createWorkflowProgramDriver(adapterTools)],
    ]);
    const outerKeyring = createCapabilityKeyring("ordinary-harness-outer", [
      { keyId: "active", secret: "ordinary-harness-outer-key-32bytes" },
    ]);
    let authority = createAuthorityScenarioDriver({
      journalId: "ordinary-harness-outer",
      journalIncarnation: "1",
      keyring: outerKeyring,
      schemaRegistry: innerSchemas(),
    });
    const sessionId = "ordinary-harness-session";
    const taskId = "turn-0/root";
    const attach = attachRequest(sessionId, taskId, request);

    await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const effects = createDurableEffectRegistry([
        ...createToolInvocationForeignEffectRegistrations({
          // SAFETY: the facade implements the callable RuntimeTool boundary;
          // its older AnyToolContract declaration omits the schemas property.
          tools: new Map<string, RuntimeTool>([[facade.name, facade as unknown as RuntimeTool]]),
        }),
      ]);
      const sample: Parameters<typeof withModelSampleTestBoundary>[0] = function* () {
        const round = outerModelSamples;
        outerModelSamples += 1;
        return {
          message: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: `suggestion-${round}` }],
            },
            source: null,
            usage: null,
            stopReason: null,
            responseId: null,
            errorMessage: null,
          },
          output: { type: "message" },
        };
      };
      yield* authority.openTask({
        sessionId,
        turnId: "turn-0",
        taskId,
        manifest: FOREIGN_TOOL_ADAPTER_MANIFEST,
        input: request,
        executionEpoch: 1,
        attachmentId: "unattached-outer-adapter",
        audience: "workflow-host",
      });

      expect(yield* runProgram(attach, authority, drivers, effects, sample)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      authority = recreateAuthority(authority, outerKeyring);
      yield* acceptPending(authority, sessionId, taskId, {
        answer: "answer-0",
        continue: true,
      });
      authority = recreateAuthority(authority, outerKeyring);

      expect(yield* runProgram(attach, authority, drivers, effects, sample)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      authority = recreateAuthority(authority, outerKeyring);
      yield* acceptPending(authority, sessionId, taskId, {
        answer: "answer-1",
        continue: false,
      });
      authority = recreateAuthority(authority, outerKeyring);

      expect(yield* runProgram(attach, authority, drivers, effects, sample)).toEqual({
        state: "completed",
        value: { answers: ["answer-0", "answer-1"] },
      });

      const innerSnapshot = yield* stateStore.load(taskId);
      expect(innerSnapshot).toBeDefined();
      if (!innerSnapshot) {
        throw new Error("Missing inner durable journal snapshot");
      }
      const innerAuthority = createAuthorityScenarioDriver({
        journalId: `durable-tool-facade:${innerManifest.programId}`,
        journalIncarnation: "1",
        keyring,
        snapshot: innerSnapshot,
        schemaRegistry: innerSchemas(),
      });
      const innerJournal = innerAuthority.readJournal(taskId);
      // Sampling parks as a native kernel pull under the workflow runtime.
      expect(countPulls(innerJournal, "sample")).toBe(2);
      expect(countPulls(innerJournal, "elicit")).toBe(2);
      expect(innerJournal.at(-1)?.payload).toMatchObject({
        type: "TaskClosed",
        outcome: {
          status: "ok",
          value: { answers: ["answer-0", "answer-1"] },
        },
      });

      const outerJournal = authority.readJournal(sessionId);
      expect(countEffectPulls(outerJournal, "foreign.tool.start")).toBe(1);
      expect(countEffectPulls(outerJournal, "foreign.tool.continue")).toBe(4);
      expect(countPulls(outerJournal, "sample")).toBe(2);
      expect(countPulls(outerJournal, "elicit")).toBe(2);
      expect(JSON.stringify(outerJournal)).not.toContain("inner-model");
    });

    // Workflow runtime replays the program body once per parked pull
    // (2 samples + 2 elicits + completing run), not per journal batch.
    expect(innerFactories).toBe(5);
    expect(innerActivations).toBe(5);
    expect(outerModelSamples).toBe(2);
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
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
}

function runProgram(
  attach: AttachProgramRequest,
  authority: ReturnType<typeof createAuthorityScenarioDriver>,
  drivers: ReturnType<typeof createProgramDriverRegistry>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
  sample: Parameters<typeof withModelSampleTestBoundary>[0],
): Operation<AdvancementResult> {
  return ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* withProgramDriverTestScope(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* withModelSampleTestBoundary(sample, () =>
          driveInstalledTestProgramTree({ attach }),
        );
      });
    });
  });
}

function recreateAuthority(
  authority: ReturnType<typeof createAuthorityScenarioDriver>,
  keyring: ReturnType<typeof createCapabilityKeyring>,
) {
  return createAuthorityScenarioDriver({
    journalId: "ordinary-harness-outer",
    journalIncarnation: "1",
    keyring,
    schemaRegistry: innerSchemas(),
    snapshot: authority.exportSnapshot(),
  });
}

function* acceptPending(
  authority: ReturnType<typeof createAuthorityScenarioDriver>,
  sessionId: string,
  taskId: string,
  content: Choice,
): Operation<void> {
  const records = authority.readJournal(sessionId);
  const resolved = new Set(
    records.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  let record: DurableSemanticRecord | undefined;
  for (const candidate of records) {
    if (
      candidate.payload.type === "PullRequested" &&
      candidate.payload.taskId === taskId &&
      candidate.payload.descriptor.kind === "elicit" &&
      !resolved.has(candidate.payload.pullId)
    ) {
      record = candidate;
    }
  }
  if (!record || record.payload.type !== "PullRequested") {
    throw new Error("No pending outer elicitation");
  }
  const result = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, taskId, record.payload.pullId),
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

function countPulls(records: DurableSemanticRecord[], kind: "elicit"): number {
  return records.filter(
    (record) => record.payload.type === "PullRequested" && record.payload.descriptor.kind === kind,
  ).length;
}
