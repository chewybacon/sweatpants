import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  createDurableToolRegistry,
  createPinnedDurableProgram,
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
  stableProgramAttachmentId,
  type DurableProgramManifest,
  type Json,
  type ProgramElicitResult,
} from "@sweatpants/durable-execution";
import { assertJson, canonicalSnapshot } from "@sweatpants/foundation";
import { DurableEffectRouting } from "@sweatpants/durable-effects/runtime";
import {
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "../testing/program-driver-host.ts";
import { createAuthorityScenarioDriver } from "../testing.ts";
import { projectExecutionForest } from "../execution-forest.ts";
import { booleanGuard, createSchemaFixture, stringGuard } from "../schema-fixtures.ts";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation";
import { createCapabilityKeyring } from "../capabilities.ts";
import { createDurableSchemaRegistry } from "../schema-registry.ts";
import { InstalledEffectPort } from "../workflow/runtime.ts";
import { createWorkflowProgramDriver } from "../workflow/program-driver.ts";

const programInput = createSchemaFixture(
  "fixture.flip/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const programOutput = createSchemaFixture(
  "fixture.flip/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const echoInput = createSchemaFixture(
  "fixture.flip/echo-input",
  "effect_input",
  { type: "object" },
  () => undefined,
);
const echoOutput = createSchemaFixture(
  "fixture.flip/echo-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const approvalResponse = createSchemaFixture(
  "fixture.flip/approval-response",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);
const schemaRegistry = () =>
  createDurableSchemaRegistry([
    programInput.entry,
    programOutput.entry,
    echoInput.entry,
    echoOutput.entry,
    approvalResponse.entry,
  ]);
const keyring = createCapabilityKeyring("flip-authority", [
  { keyId: "flip-key", secret: "x".repeat(32) },
]);
const digest = "9".repeat(64);

const manifest: DurableProgramManifest = {
  programId: "fixture.flip",
  version: "1.0.0",
  digest,
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {
    approval: { response: approvalResponse.descriptor },
  },
  effects: {
    echo: {
      name: "echo",
      version: "1.0.0",
      inputSchema: echoInput.descriptor,
      outputSchema: echoOutput.descriptor,
      retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
    },
  },
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

function attach(sessionId: string) {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "hello",
    route: { driverKind: "program" as const },
    executionEpoch: 1,
  };
}

function makeAuthority(journalId: string) {
  return createAuthorityScenarioDriver({
    journalId,
    journalIncarnation: "incarnation-1",
    keyring,
    now: () => 1_000,
    schemaRegistry: schemaRegistry(),
  });
}

function payloadTypes(records: readonly { payload: { type: string } }[]): string[] {
  return records.map((entry) => entry.payload.type);
}

interface ScenarioResult {
  value: string;
  journalTypes: string[];
  forest: unknown;
  settledValues: Json[];
}

const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
  const a = yield* context.record({ key: "step-one" }, function* () {
    return "one";
  });
  const echoed = yield* context.effect<string>(
    "echo",
    "1.0.0",
    { message: a },
    { audience: "program-execution" },
  );
  yield* context.emit("workflow.flip/between", { after: echoed });
  const b = yield* context.record({ key: "step-two" }, function* () {
    return "two";
  });
  return `${a}|${echoed}|${b}`;
});

const parkedTool = createPinnedDurableProgram(manifest, function* (_input, context) {
  const approval = (yield* context.pull(
    assertJson({
      kind: "elicit",
      key: "approval",
      message: "Continue?",
      response: approvalResponse.descriptor,
    }),
  )) as ProgramElicitResult<boolean>;
  return `approved:${String(approval.action)}`;
});

describe("workflow runtime behind the ProgramDriver contract", () => {
  const sessionId = "driver-flip";

  async function runWorkflowDriver(): Promise<ScenarioResult> {
    return run(function* () {
      const authority = makeAuthority("journal-flip-workflow");
      const handlers = new Map([
        [
          "echo",
          (input: Json) =>
            (function* () {
              return `${(input as { message: string }).message}-executed`;
            })(),
        ],
      ]);
      const drivers = createProgramDriverRegistry([
        [
          "program",
          createWorkflowProgramDriver(createDurableToolRegistry([tool]), {
            effectHandlers: handlers,
          }),
        ],
      ]);
      const request = attach(sessionId);
      yield* withProgramDriverTestScope(authority, function* () {
        yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        yield* DurableEffectRouting.around({
          *route() {
            return { placement: "execution" as const };
          },
        });
        yield* ProgramDriverRegistryContext.with(drivers, function* () {
          yield* driveInstalledTestProgramTree({
            attach: request,
          });
        });
      });
      const journal = authority.readJournal(sessionId);
      const closed = journal.find((entry) => entry.payload.type === "TaskClosed");
      if (!closed || closed.payload.type !== "TaskClosed") throw new Error("workflow not closed");
      return {
        value: (closed.payload.outcome as { value: string }).value,
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: journal
          .filter((entry) => entry.payload.type === "PullResolved")
          .map((entry) => (entry.payload.outcome as { value: string }).value),
      };
    }) as unknown as Promise<ScenarioResult>;
  }

  it("runs the tool through the workflow driver", async () => {
    const result = await runWorkflowDriver();

    expect(result.value).toBe("one|one-executed|two");
    expect(result.settledValues).toEqual(["one", "one-executed", "two"]);
    expect(result.journalTypes).toContain("TaskClosed");
    expect(result.forest).toBeDefined();
  });

  it("parks and resumes elicitations across activations through the driver", async () => {
    const sessionId = "driver-parked";
    let pullId = "";
    let capability = "";

    async function runSide(journalId: string) {
      return run(function* () {
        const authority = makeAuthority(journalId);
        const drivers = createProgramDriverRegistry([
          ["program", createWorkflowProgramDriver(createDurableToolRegistry([parkedTool]))],
        ]);
        const request = attach(sessionId);
        let firstState = "";
        let firstReason = "";
        let secondValue = "";
        yield* withProgramDriverTestScope(authority, function* () {
          const opened = yield* authority.openTask({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            manifest,
            input: request.input,
            executionEpoch: 1,
            attachmentId: stableProgramAttachmentId(request),
            audience: "program-host",
          });
          const activate = (epoch: number, attachmentSuffix: string) =>
            ProgramDriverRegistryContext.with(drivers, function* () {
              let capabilityForRun = opened.programCapability;
              if (epoch > 1) {
                const bound = (yield* authority.bindProgramAttachment(
                  request.sessionId,
                  request.taskId,
                  stableProgramAttachmentId(request) + attachmentSuffix,
                  1,
                )) as unknown as { programCapability: string };
                capabilityForRun = bound.programCapability;
              }
              return yield* driveInstalledTestProgramTree({
                attach: request,
                programCapability: capabilityForRun,
              });
            });
          const firstRun = yield* activate(1, "");
          if (firstRun.state !== "parked" || firstRun.reason !== "elicit") {
            throw new Error(`expected parked elicit, got ${firstRun.state}/${firstRun.reason}`);
          }
          firstState = firstRun.state;
          firstReason = firstRun.reason ?? "";
          const pending = authority
            .readJournal(sessionId)
            .find(
              (entry) =>
                entry.payload.type === "PullRequested" &&
                entry.payload.descriptor.kind === "elicit",
            );
          if (!pending || pending.payload.type !== "PullRequested") {
            throw new Error("elicitation was not recorded");
          }
          pullId = pending.payload.pullId;
          capability = authority.resolutionCapability(sessionId, request.taskId, pullId);
          // Settle while parked.
          const validated = yield* authority.validateElicitResponse({
            sessionId,
            pullId,
            participantId: "user:approval",
            completion: { action: "accept", content: true },
          });
          if (validated.status !== "valid") {
            throw new Error(`validation failed: ${validated.status}`);
          }
          const resolved = yield* authority.resolve({
            capability,
            audience: validated.audience,
            outcome: validated.outcome,
          });
          if (resolved.status !== "accepted") {
            throw new Error(`resolution rejected: ${resolved.status}`);
          }
          void capability;
          const secondRun = yield* activate(2, "-2");
          if (secondRun.state !== "completed") {
            throw new Error(`second run ${secondRun.state}`);
          }
          secondValue = secondRun.value ?? "";
        });
        const journal = authority.readJournal(sessionId);
        return {
          firstState,
          firstReason,
          value: secondValue,
          journalTypes: payloadTypes(journal),
          forest: canonicalSnapshot(projectExecutionForest(journal)),
        };
      }) as unknown as Promise<{
        firstState: string;
        firstReason: string;
        value: string;
        journalTypes: string[];
        forest: unknown;
      }>;
    }

    const result = await runSide("journal-parked-workflow");
    expect(result.firstState).toBe("parked");
    expect(result.firstReason).toBe("elicit");
    expect(result.value).toBe("approved:accept");
    expect(result.journalTypes).toContain("TaskClosed");
    expect(result.forest).toBeDefined();
  });
});
