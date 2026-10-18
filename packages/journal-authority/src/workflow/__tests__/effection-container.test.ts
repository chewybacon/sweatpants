import { run, scoped, createContext, spawn, suspend, withResolvers } from "effection";
import { expect, it } from "vitest";
import { EffectionKernel } from "../effection-kernel.ts";
import { elicit, effect, openProgramAttachment } from "../runtime.ts";
import { createCapabilityKeyring } from "../../contract/capabilities.ts";
import { createInMemoryJournal } from "../../shell/in-memory-journal.ts";
import { createDurableSchemaRegistry } from "../../contract/schema-registry.ts";
import { createSchemaFixture, stringGuard } from "../../testing/schema-fixtures.ts";
import type { DurableProgramManifest, ResolutionReceipt } from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";

const input = createSchemaFixture(
  "container/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const output = createSchemaFixture(
  "container/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const effectInput = createSchemaFixture(
  "container/effect-input",
  "effect_input",
  { type: "string" },
  stringGuard,
);
const effectOutput = createSchemaFixture(
  "container/effect-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const answer = createSchemaFixture(
  "container/answer",
  "elicitation_response",
  { type: "string" },
  stringGuard,
);
const manifest: DurableProgramManifest = {
  programId: "container-spike",
  version: "1",
  digest: "c".repeat(64),
  inputSchema: input.descriptor,
  outputSchema: output.descriptor,
  effects: {
    prepare: {
      name: "prepare",
      version: "1",
      inputSchema: effectInput.descriptor,
      outputSchema: effectOutput.descriptor,
      retrySafety: { mode: "repeatable" },
    },
  },
  elicits: { confirm: { response: answer.descriptor } },
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};
const request = {
  sessionId: "container-replay",
  taskId: "root",
  program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
  input: "draft",
  route: { driverKind: "container-spike" },
  executionEpoch: 1,
};
const ContainerName = createContext<string>("container-name");

it("disposes at a question, then replays accepted work in a fresh container without repeating the effect", async () => {
  await run(function* () {
    const journal = yield* createInMemoryJournal({
      journalId: "container-spike",
      journalIncarnation: "1",
      keyring: createCapabilityKeyring("container", [{ keyId: "test", secret: "x".repeat(32) }]),
      schemaRegistry: createDurableSchemaRegistry(
        [input, output, effectInput, effectOutput, answer].map((s) => s.entry),
      ),
      now: () => 1000,
    });
    const opened = yield* journal.advance({
      type: "execution.open-task",
      request: {
        ...request,
        turnId: "turn",
        manifest,
        attachmentId: "first",
        audience: "program-host",
      },
    });
    let attempts = 0;
    const starts: string[] = [];
    const releases: string[] = [];
    function* program() {
      const name = yield* ContainerName.expect();
      starts.push(name);
      try {
        const prepared = yield* effect(
          {
            name: "prepare",
            version: "1",
            input: "draft",
            resolver: { audience: "program-execution" },
          },
          function* () {
            attempts++;
            return "prepared";
          },
        );
        const reply = yield* elicit({
          key: "confirm",
          message: `Send ${prepared}?`,
          response: answer.descriptor,
        });
        if (
          !reply ||
          typeof reply !== "object" ||
          Array.isArray(reply) ||
          reply.action !== "accept" ||
          typeof reply.content !== "string"
        ) {
          throw new Error("expected accepted answer");
        }
        return `${prepared}:${reply.content}`;
      } finally {
        releases.push(name);
      }
    }
    let questionCapability = "";
    let questionPullId = "";
    let effectReceipt: ResolutionReceipt;
    let effectOutcome: OperationOutcome;

    // First activation: perform and accept work, reach the question, release compute.
    yield* scoped(function* () {
      yield* ContainerName.set("first");
      const container = yield* openProgramAttachment(request, program);
      const proposed = yield* container.exchange({ type: "start", input: request.input });
      if (proposed.type !== "record-proposed") {
        throw new Error("expected preparation");
      }
      const reserved = yield* journal.advance({
        type: "execution.reserve-pull",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          turnId: "turn",
          actionIndex: 0,
          pullIndex: 0,
          descriptor: proposed.descriptor,
          programCapability: opened.programCapability,
        },
      });
      if (reserved.status !== "authorized") {
        throw new Error("expected authorized preparation");
      }
      const attempted = yield* container.exchange({
        type: "authorize-record",
        actionIndex: 0,
        pullId: reserved.pullId,
        attemptId: reserved.attemptId,
        descriptor: proposed.descriptor,
      });
      if (attempted.type !== "record-attempt-completed") {
        throw new Error("expected preparation result");
      }
      const accepted = yield* journal.advance({
        type: "execution.resolve-pull",
        request: {
          capability: reserved.resolutionCapability,
          audience: "program-execution",
          outcome: attempted.outcome,
        },
      });
      if (accepted.status !== "accepted") {
        throw new Error("preparation rejected");
      }
      effectReceipt = accepted.receipt;
      effectOutcome = attempted.outcome;
      const question = yield* container.exchange({
        type: "resume-record",
        actionIndex: 0,
        outcome: effectOutcome,
        receipt: effectReceipt,
        replayed: false,
      });
      expect(question).toMatchObject({
        type: "record-proposed",
        actionIndex: 1,
        descriptor: { kind: "elicit", message: "Send prepared?" },
      });
      if (question.type !== "record-proposed") {
        throw new Error("expected question");
      }
      const pending = yield* journal.advance({
        type: "execution.reserve-pull",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          turnId: "turn",
          actionIndex: 1,
          pullIndex: 1,
          descriptor: question.descriptor,
          programCapability: opened.programCapability,
        },
      });
      if (pending.status !== "pending") {
        throw new Error("expected unanswered question");
      }
      questionCapability = pending.resolutionCapability!;
      questionPullId = pending.pullId;
      yield* container.close("parked");
      expect(releases).toEqual(["first"]);
      let stale: unknown;
      try {
        yield* container.exchange({ type: "start", input: request.input });
      } catch (error) {
        stale = error;
      }
      expect(stale).toBeDefined();
    });
    expect(attempts).toBe(1);

    // The participant answers while no container exists. Only the journal survives.
    const validated = yield* journal.query({
      type: "pull.validate-elicit-response",
      request: {
        sessionId: request.sessionId,
        pullId: questionPullId,
        participantId: "user:confirm",
        completion: { action: "accept", content: "yes" },
      },
    });
    if (validated.status !== "valid") {
      throw new Error("invalid answer");
    }
    const accepted = yield* journal.advance({
      type: "execution.resolve-pull",
      request: {
        capability: questionCapability,
        audience: validated.audience,
        outcome: validated.outcome,
      },
    });
    expect(accepted.status).toBe("accepted");

    // Fresh activation/container: re-execute the generator, replay authority receipts.
    yield* scoped(function* () {
      yield* ContainerName.set("second");
      const bound = yield* journal.advance({
        type: "execution.bind-attachment",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          attachmentId: "second",
          executionEpoch: 1,
        },
      });
      const container = yield* openProgramAttachment(request, program);
      const preparation = yield* container.exchange({ type: "start", input: request.input });
      if (preparation.type !== "record-proposed") {
        throw new Error("expected replay preparation");
      }
      const replay = yield* journal.advance({
        type: "execution.reserve-pull",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          turnId: "turn",
          actionIndex: 0,
          pullIndex: 0,
          descriptor: preparation.descriptor,
          programCapability: bound.programCapability,
        },
      });
      if (replay.status !== "resolved") {
        throw new Error("expected accepted preparation");
      }
      const question = yield* container.exchange({
        type: "resume-record",
        actionIndex: 0,
        receipt: replay.receipt,
        outcome: replay.outcome,
        replayed: true,
      });
      if (question.type !== "record-proposed") {
        throw new Error("expected replay question");
      }
      const answered = yield* journal.advance({
        type: "execution.reserve-pull",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          turnId: "turn",
          actionIndex: 1,
          pullIndex: 1,
          descriptor: question.descriptor,
          programCapability: bound.programCapability,
        },
      });
      if (answered.status !== "resolved") {
        throw new Error("expected accepted answer");
      }
      expect(answered.receipt.pullId).toBe(questionPullId);
      const completed = yield* container.exchange({
        type: "resume-record",
        actionIndex: 1,
        receipt: answered.receipt,
        outcome: answered.outcome,
        replayed: true,
      });
      expect(completed).toMatchObject({ type: "completed", actionIndex: 2, value: "prepared:yes" });
      yield* container.close("scope_exit");
    });
    expect(starts).toEqual(["first", "second"]);
    expect(releases).toEqual(["first", "second"]);
    expect(attempts).toBe(1);
  });
});

it("cancel reaches authored cleanup; dispose releases compute without publishing cleanup requests", async () => {
  await run(function* () {
    let released = 0;
    function* program() {
      try {
        yield* elicit({ key: "confirm", message: "Proceed?", response: answer.descriptor });
      } finally {
        released++;
        yield* elicit({ key: "confirm", message: "Clean up?", response: answer.descriptor });
      }
      return "done";
    }
    const first = yield* EffectionKernel.start(program, null);
    expect(first.boundary.kind).toBe("suspended");
    const cleanup = yield* first.execution.cancel("user stopped");
    expect(cleanup).toMatchObject({
      kind: "suspended",
      request: {
        kind: "record",
        boundary: { serializable: { descriptor: { message: "Clean up?" } } },
      },
    });
    if (cleanup.kind !== "suspended") {
      throw new Error("expected cleanup");
    }
    const cancelled = yield* first.execution.resume(cleanup.suspensionId, {
      kind: "record",
      outcome: { status: "ok", value: "yes" },
    });
    expect(cancelled).toEqual({ kind: "cancelled", reason: "user stopped" });
    yield* first.execution.dispose();

    const second = yield* EffectionKernel.start(program, null);
    yield* second.execution.dispose();
    yield* second.execution.dispose();
    expect(released).toBe(2);
    let closed: unknown;
    try {
      yield* second.execution.cancel();
    } catch (error) {
      closed = error;
    }
    expect(closed).toMatchObject({ message: "execution_closed" });
  });
});

it("the container forwards logical cancellation into the kernel and can dispose at its cleanup boundary", async () => {
  await run(function* () {
    let released = false;
    const container = yield* openProgramAttachment(request, function* () {
      try {
        yield* elicit({ key: "confirm", message: "Proceed?", response: answer.descriptor });
      } finally {
        try {
          yield* elicit({ key: "confirm", message: "Clean up?", response: answer.descriptor });
        } finally {
          released = true;
        }
      }
      return "done";
    });
    yield* container.exchange({ type: "start", input: request.input });
    const cleanup = yield* container.exchange({ type: "cancel", reason: "user stopped" });
    expect(cleanup).toMatchObject({
      type: "record-proposed",
      descriptor: { message: "Clean up?" },
    });
    expect(released).toBe(false);
    yield* container.close("parked");
    expect(released).toBe(true);
  });
});

it("the container rejects a foreign replay receipt before the kernel advances", async () => {
  await run(function* () {
    let advanced = false;
    const container = yield* openProgramAttachment(request, function* () {
      yield* elicit({ key: "confirm", message: "Proceed?", response: answer.descriptor });
      advanced = true;
      return "done";
    });
    yield* container.exchange({ type: "start", input: request.input });
    let rejected: unknown;
    try {
      yield* container.exchange({
        type: "resume-record",
        actionIndex: 0,
        replayed: true,
        outcome: { status: "ok", value: "yes" },
        receipt: {
          sessionId: "another-session",
          taskId: request.taskId,
          pullId: "foreign",
          resolutionOffset: "1",
          outcomeDigest: "a".repeat(64),
          status: "accepted",
        },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: "program_protocol_error" });
    expect(advanced).toBe(false);
  });
});

it("disposes an interrupted start without waiting for an authored cleanup question", async () => {
  await run(function* () {
    const entered = withResolvers<void>();
    let released = false;
    const starting = yield* spawn(function* () {
      yield* EffectionKernel.start(function* () {
        try {
          entered.resolve();
          yield* suspend();
        } finally {
          try {
            yield* elicit({ key: "confirm", message: "Clean up?", response: answer.descriptor });
          } finally {
            released = true;
          }
        }
        return "unreachable";
      }, null);
    });
    yield* entered.operation;
    yield* starting.halt();
    expect(released).toBe(true);
  });
});
