import { run, scoped, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import type { Json } from "@sweatpants/foundation";
import { createCapabilityKeyring } from "../capabilities.ts";
import { AuthorityJournalPort, JournalAuthorityPort } from "../authority-ports.ts";
import { createInMemoryShellDrivers } from "../in-memory-shell.ts";
import { createDurableSchemaRegistry } from "../schema-registry.ts";
import { createSchemaFixture, stringGuard } from "../schema-fixtures.ts";
import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import {
  emit,
  openProgramAttachment,
  programCommandParser,
  record,
  type ProgramEvent,
  type Workflow,
} from "./runtime.ts";

const inputSchema = createSchemaFixture(
  "workflow.emission/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const outputSchema = createSchemaFixture(
  "workflow.emission/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const schemaRegistry = () => createDurableSchemaRegistry([inputSchema.entry, outputSchema.entry]);
const keyring = createCapabilityKeyring("emission-authority", [
  { keyId: "emission-key", secret: "x".repeat(32) },
]);
const digest = "b".repeat(64);
const manifest: DurableProgramManifest = {
  programId: "workflow.emission",
  version: "1.0.0",
  digest,
  inputSchema: inputSchema.descriptor,
  outputSchema: outputSchema.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

function attach(sessionId: string) {
  return {
    sessionId,
    taskId: "task-root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "input",
    route: { driverKind: "emission-test" },
    executionEpoch: 1,
  };
}

function* installMemoryAuthority(sessionId: string): Operation<string> {
  yield* JournalAuthorityPort.installDriver(
    createInMemoryShellDrivers({
      journalId: `emission-${sessionId}`,
      journalIncarnation: "1",
      keyring,
      schemaRegistry: schemaRegistry(),
      now: () => 1_000,
    }).authority,
  );
  yield* AuthorityJournalPort.installDriver(
    createInMemoryShellDrivers({
      journalId: `emission-${sessionId}`,
      journalIncarnation: "1",
      keyring,
      schemaRegistry: schemaRegistry(),
      now: () => 1_000,
    }).journal,
  );
  const opened = yield* JournalAuthorityPort.api.operations.command({
    type: "execution.open-task",
    request: {
      sessionId,
      turnId: "turn-0",
      taskId: "task-root",
      manifest,
      input: "input",
      executionEpoch: 1,
      attachmentId: `attachment-${sessionId}`,
      audience: "program-host",
      route: { driverKind: "emission-test" },
    },
  });
  return opened.programCapability;
}

function expectEvent(event: ProgramEvent, type: ProgramEvent["type"]): void {
  if (event.type !== type) {
    throw new Error(`expected ${type}, got ${event.type}`);
  }
}

describe("emission boundaries", () => {
  it("appends an authority-visible emission and resumes on host acknowledgement", async () => {
    const request = attach("emit-pure");
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          const offset = yield* emit("workflow.emission/test", { n: 1 });
          return offset;
        });
        const started = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(started, "emission-proposed");
        if (started.type !== "emission-proposed") return;
        expect(started.descriptor).toEqual({
          eventType: "workflow.emission/test",
          payload: { n: 1 },
        });
        const receipt = yield* authority.command({
          type: "execution.append-emission",
          request: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            actionIndex: started.actionIndex,
            descriptor: started.descriptor,
            programCapability,
          },
        });
        const recorded = yield* handle.exchange({
          type: "ack-emission",
          actionIndex: started.actionIndex,
          offset: receipt.offset,
        });
        expectEvent(recorded, "completed");
        if (recorded.type === "completed") {
          expect(recorded.value).toBe(receipt.offset);
        }
      });
    });
  });

  it("advances actionIndex across a settled record and a following emission", async () => {
    const request = attach("emit-mixed");
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          const recorded = yield* record({ key: "before-emit" }, function* () {
            return "body";
          });
          const offset = yield* emit("workflow.emission/after-record", { recorded });
          return `${recorded}:${offset}`;
        });
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(proposed, "record-proposed");
        if (proposed.type !== "record-proposed") return;
        const reserved = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: proposed.descriptor,
            programCapability,
          },
        });
        if (reserved.status !== "authorized" || reserved.descriptor.kind !== "record") {
          throw new Error(`unexpected reservation ${reserved.status}`);
        }
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: reserved.pullId,
          attemptId: reserved.attemptId,
          descriptor: proposed.descriptor,
        });
        expectEvent(attempted, "record-attempt-completed");
        if (attempted.type !== "record-attempt-completed") throw new Error("attempt missing");
        const resolved = yield* authority.command({
          type: "execution.resolve-pull",
          request: {
            capability: reserved.resolutionCapability,
            audience: "program-execution",
            outcome: attempted.outcome,
          },
        });
        if (resolved.status !== "accepted") {
          throw new Error(
            `resolution rejected: ${"code" in resolved ? resolved.code : resolved.status}`,
          );
        }
        const resumed = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: attempted.outcome,
          receipt: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            pullId: reserved.pullId,
            resolutionOffset: resolved.receipt.resolutionOffset,
            outcomeDigest: resolved.receipt.outcomeDigest,
            status: "accepted",
          },
          replayed: false,
        });
        expectEvent(resumed, "emission-proposed");
        if (resumed.type !== "emission-proposed") return;
        expect(resumed.actionIndex).toBe(1);
        const receipt = yield* authority.command({
          type: "execution.append-emission",
          request: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            actionIndex: resumed.actionIndex,
            descriptor: resumed.descriptor,
            programCapability,
          },
        });
        const terminal = yield* handle.exchange({
          type: "ack-emission",
          actionIndex: resumed.actionIndex,
          offset: receipt.offset,
        });
        expectEvent(terminal, "completed");
        if (terminal.type === "completed") {
          expect(terminal.actionIndex).toBe(2);
          expect(terminal.value).toBe(`body:${receipt.offset}`);
        }
      });
    });
  });

  it("fails closed when an emission acknowledgement does not match", async () => {
    const request = attach("emit-mismatch");
    let failure: unknown;
    await run(function* () {
      yield* scoped(function* () {
        yield* installMemoryAuthority(request.sessionId);
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          return yield* emit("workflow.emission/mismatch", {});
        });
        yield* handle.exchange({ type: "start", input: request.input });
        try {
          yield* handle.exchange({
            type: "ack-emission",
            actionIndex: 7,
            offset: "0",
          });
        } catch (error) {
          failure = error;
        }
      });
    });
    expect(failure).toMatchObject({ code: "program_protocol_error" });
  });

  it("round-trips emission commands through the closed parser", () => {
    const parsed = programCommandParser.parse({
      type: "ack-emission",
      actionIndex: 3,
      offset: "12",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { type: "ack-emission", actionIndex: 3, offset: "12" },
    });
    expect(
      programCommandParser.parse({ type: "ack-emission", actionIndex: -1, offset: "0" }).ok,
    ).toBe(false);
  });
});
