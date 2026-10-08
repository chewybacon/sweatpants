import { scoped } from "effection";
import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/agent-sdk";
import { createCapabilityKeyring, type DurableSemanticRecord } from "@sweatpants/journal-authority";
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
  createDurableToolRegistry,
  type AttachProgramRequest,
  type EphemeralToolRequest,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import {
  EPHEMERAL_TOOL_ADAPTER_MANIFEST,
  ephemeralToolAdapter,
  ephemeralToolSchemaEntries,
} from "@sweatpants/tool-session/ephemeral";

import { createLocalToolInvocationRuntime } from "../index.ts";
import { createToolInvocationEphemeralEffectRegistrations } from "@sweatpants/tool-session/execution";
import { withModelSampleTestBoundary } from "./model-sample-test-boundary.ts";

describe("ToolSession ephemeral-tool durability boundary", () => {
  it("returns malformed continuation responses as expected failure values", async () => {
    const tool = createTool("sample_once")
      .description("Samples once")
      .parameters(z.object({}))
      .samples()
      .execute(function* (_input, context) {
        return yield* context.sample({ prompt: "sample" });
      });

    const result = await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const [start, continueRegistration] = createToolInvocationEphemeralEffectRegistrations({
        tools: new Map<string, RuntimeTool>([[tool.name, tool]]),
      });
      const effectContext = {
        sessionId: "malformed-response",
        taskId: "turn-0/root",
        pullId: "pull-0",
        attemptId: "attempt-0",
        cancellation: new AbortController().signal,
        resolver: { audience: "ephemeral-tool" },
      };
      const startedDisposition = yield* start.handler(
        {
          driver: "tool-session",
          tool: tool.name,
          input: {},
          durability: "ephemeral_handle",
        },
        effectContext,
      );
      if (startedDisposition.status !== "ok") {
        throw new Error("Ephemeral start returned a non-success disposition");
      }
      const started = startedDisposition.value;
      if (!started || typeof started !== "object" || Array.isArray(started)) {
        throw new Error("Ephemeral start returned a non-object disposition");
      }
      const continuation = started["continuation"];
      if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
        throw new Error("Ephemeral start did not return a continuation");
      }
      const state = continuation["state"];
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("Ephemeral continuation did not contain state");
      }
      const invocationSessionId = state["sessionId"];
      if (typeof invocationSessionId !== "string") {
        throw new Error("Ephemeral continuation did not contain a session ID");
      }
      const effectDisposition = yield* continueRegistration.handler(
        {
          continuation,
          response: { kind: "sample", value: { invalid: true } },
        },
        effectContext,
      );
      return {
        disposition:
          effectDisposition.status === "ok" ? effectDisposition.value : effectDisposition,
      };
    });

    expect(result).toMatchObject({
      disposition: {
        type: "failed",
        error: { code: "ephemeral_sample_response_invalid", retryable: false },
      },
    });
  });

  it("fails without restarting when an ephemeral ToolSession host disappears", async () => {
    return await run(function* () {
      let toolBodyExecutions = 0;
      let ephemeralStarts = 0;
      const tool = createTool("lost_ephemeral_tool")
        .description("A ephemeral tool whose live host will disappear")
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
      const request: EphemeralToolRequest = {
        driver: "tool-session",
        tool: tool.name,
        input: { topic: "durability" },
        durability: "ephemeral_handle",
      };
      const tools = createDurableToolRegistry([ephemeralToolAdapter]);
      const drivers = createProgramDriverRegistry([
        ["program", createWorkflowProgramDriver(tools)],
      ]);
      const keyring = createCapabilityKeyring("ephemeral-loss", [
        { keyId: "active", secret: "ephemeral-loss-secret-is-32-bytes!!" },
      ]);
      let authority = yield* createAuthorityScenarioDriver({
        journalId: "ephemeral-loss",
        journalIncarnation: "1",
        keyring,
        schemaRegistry: createDurableSchemaRegistry(ephemeralToolSchemaEntries()),
      });
      const sessionId = "ephemeral-loss-session";
      const taskId = "turn-0/root";
      const attach = attachRequest(sessionId, taskId, request);

      const firstRun = yield* scoped(function* () {
        yield* createLocalToolInvocationRuntime({});
        const registrations = createToolInvocationEphemeralEffectRegistrations({
          tools: new Map<string, RuntimeTool>([[tool.name, tool]]),
        });
        const [startRegistration] = registrations;
        const effects = createDurableEffectRegistry([
          {
            ...startRegistration,
            handler(input, context) {
              ephemeralStarts += 1;
              return startRegistration.handler(input, context);
            },
          },
          ...registrations.slice(1),
        ]);
        yield* authority.openTask({
          sessionId,
          turnId: "turn-0",
          taskId,
          manifest: EPHEMERAL_TOOL_ADAPTER_MANIFEST,
          input: request,
          executionEpoch: 1,
          attachmentId: "unattached-adapter",
          audience: "workflow-host",
        });
        return yield* runProgram(attach, authority, drivers, effects, function* () {
          return {
            message: {
              message: { role: "assistant", content: [{ type: "text", text: "suggestion-0" }] },
              source: null,
              usage: null,
              stopReason: null,
              responseId: null,
              errorMessage: null,
            },
            output: { type: "message" },
          };
        });
      });
      expect(firstRun).toMatchObject({ state: "parked", reason: "elicit" });

      authority = yield* recreate(authority, keyring);
      yield* scoped(() => acceptPending(authority, sessionId, taskId));
      authority = yield* recreate(authority, keyring);

      const recovered = yield* scoped(function* () {
        yield* createLocalToolInvocationRuntime({});
        const effects = createDurableEffectRegistry([
          ...createToolInvocationEphemeralEffectRegistrations({
            tools: new Map<string, RuntimeTool>([[tool.name, tool]]),
          }),
        ]);
        return yield* runProgram(attach, authority, drivers, effects, function* () {
          throw new Error("Recorded sampling must replay after host loss");
        });
      });

      expect(recovered).toMatchObject({
        state: "failed",
        error: { code: "ephemeral_continuation_lost" },
      });
      const journal = authority.readJournal(sessionId);
      expect(countEffectPulls(journal, "ephemeral.tool.start")).toBe(1);
      expect(countEffectPulls(journal, "ephemeral.tool.continue")).toBe(2);
      expect(countSamplePulls(journal)).toBe(1);
      expect(ephemeralStarts).toBe(1);
      expect(toolBodyExecutions).toBe(1);
    });
  });
});

function attachRequest(
  sessionId: string,
  taskId: string,
  input: EphemeralToolRequest,
): AttachProgramRequest {
  return {
    sessionId,
    taskId,
    program: {
      id: EPHEMERAL_TOOL_ADAPTER_MANIFEST.programId,
      version: EPHEMERAL_TOOL_ADAPTER_MANIFEST.version,
      digest: EPHEMERAL_TOOL_ADAPTER_MANIFEST.digest,
    },
    input,
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
}

function runProgram(
  attach: AttachProgramRequest,
  authority: AuthorityScenarioDriver,
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

function* recreate(
  authority: AuthorityScenarioDriver,
  keyring: ReturnType<typeof createCapabilityKeyring>,
) {
  return yield* createAuthorityScenarioDriver({
    journalId: "ephemeral-loss",
    journalIncarnation: "1",
    keyring,
    schemaRegistry: createDurableSchemaRegistry(ephemeralToolSchemaEntries()),
    snapshot: authority.exportSnapshot(),
  });
}

function* acceptPending(
  authority: AuthorityScenarioDriver,
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
    throw new Error("Missing ephemeral elicitation");
  }
  const result = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, taskId, request.payload.pullId),
    audience: "user:ephemeral_input",
    outcome: {
      status: "ok",
      value: { action: "accept", content: { answer: "answer-after-loss" } },
    },
  });
  if (result.status === "rejected") {
    throw new Error(result.code);
  }
}

function countSamplePulls(records: DurableSemanticRecord[]): number {
  return records.filter(
    (record) =>
      record.payload.type === "PullRequested" && record.payload.descriptor.kind === "sample",
  ).length;
}

function countEffectPulls(records: DurableSemanticRecord[], name: string): number {
  return records.filter(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.descriptor.kind === "effect" &&
      record.payload.descriptor.name === name,
  ).length;
}
