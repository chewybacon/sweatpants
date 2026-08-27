import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import type { ModelSamplingService } from "@sweatpants/model-sampling";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import type { ModelContext } from "@sweatpants/model-provider";
import { z } from "zod";

import { createPinnedProgramCatalog, createProgramWorkflowHost } from "../program-workflow-host.ts";
import {
  createProgramDriverJournalStore,
  programDriverSchemaRegistry,
  type ProgramDriverJournalStore,
} from "../program-driver-journal.ts";

const approvalProgram = createDurableTool("host_approval")
  .description("Ask for approval")
  .identity({ version: "1.0.0", digest: sha256("host-approval-v1") })
  .parameters(z.object({ prompt: z.string() }))
  .output(z.string())
  .elicits({
    approval: {
      response: z.object({ approved: z.boolean() }),
      context: z.object({ prompt: z.string() }),
    },
  })
  .effects({})
  .execute(function* (input, context) {
    const response = yield* context.elicit("approval", {
      message: input.prompt,
      context: { prompt: input.prompt },
    });
    return response.action === "accept" && response.content.approved ? "approved" : "declined";
  });

function sharedApprovalStore() {
  return createProgramDriverJournalStore({
    keyring: createCapabilityKeyring("local-host-test", [
      { keyId: "active", secret: "local-host-test-secret-32-bytes!!" },
    ]),
    schemaRegistry: programDriverSchemaRegistry(approvalProgram.artifacts.catalog),
  });
}

function fixture(journalStore = sharedApprovalStore()) {
  const programs = createDurableToolRegistry([approvalProgram]);
  const effects = createDurableEffectRegistry([]);
  return createProgramWorkflowHost({
    journalStore,
    programs,
    effects,
  });
}

const pin = {
  id: approvalProgram.manifest.programId,
  version: approvalProgram.manifest.version,
  digest: approvalProgram.manifest.digest,
};

const catalog = createPinnedProgramCatalog({
  host_approval: { kind: "program", target: "host_approval", program: pin },
});

describe("ProgramWorkflowHost", () => {
  it("opens, parks, accepts a typed response, resumes, and returns a normalized trace", async () => {
    const host = fixture();
    await run(function* () {
      const opened = yield* host.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "Continue?" },
        catalog,
      });
      expect(yield* opened.result).toMatchObject({ state: "parked", reason: "elicit" });

      const parkedTrace = yield* host.trace(opened.sessionId);
      const pull = parkedTrace.tasks[0]?.operations[0];
      expect(pull?.descriptor).toMatchObject({ kind: "elicit", key: "approval" });

      const completed = yield* host.respond({
        sessionId: opened.sessionId,
        taskId: opened.taskId,
        pullId: pull!.pullId,
        response: { action: "accept", content: { approved: true } },
      });
      expect(completed).toEqual({ state: "completed", value: "approved" });
      expect(
        yield* host.respond({
          sessionId: opened.sessionId,
          taskId: opened.taskId,
          pullId: pull!.pullId,
          response: { action: "accept", content: { approved: true } },
        }),
      ).toEqual({ state: "completed", value: "approved" });
      expect(yield* host.resume(opened.sessionId)).toEqual({
        state: "completed",
        value: "approved",
      });

      const trace = yield* host.trace(opened.sessionId);
      expect(trace).toMatchObject({
        version: 1,
        tasks: [
          {
            taskId: opened.taskId,
            acceptedInput: { prompt: "Continue?" },
            operations: [{ pullId: pull!.pullId, outcome: { status: "ok" } }],
            terminal: { status: "ok", value: "approved" },
          },
        ],
      });
      expect(JSON.stringify(trace)).not.toContain("capability");
    });
  });

  it("resumes through the authority recovery query without downloading the journal", async () => {
    const backing = sharedApprovalStore();
    let journalReads = 0;
    const observed: ProgramDriverJournalStore = {
      *open(conversationId) {
        const journal = yield* backing.open(conversationId);
        return {
          ...journal,
          *readJournal(sessionId) {
            journalReads += 1;
            return yield* journal.readJournal(sessionId);
          },
        };
      },
    };
    const firstHost = fixture(observed);
    const replacementHost = fixture(observed);

    await run(function* () {
      const opened = yield* firstHost.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "Recover without a scan?" },
        catalog,
      });
      const parked = yield* opened.result;
      expect(parked).toMatchObject({ state: "parked" });
      expect(journalReads).toBe(0);

      expect(yield* replacementHost.resume(opened.sessionId)).toMatchObject({ state: "parked" });
      expect(journalReads).toBe(0);

      if (parked.state !== "parked") {
        throw new Error("fixture did not park");
      }
      expect(
        yield* replacementHost.respond({
          sessionId: opened.sessionId,
          taskId: opened.taskId,
          pullId: parked.pullId,
          response: { action: "accept", content: { approved: true } },
        }),
      ).toEqual({ state: "completed", value: "approved" });
      expect(yield* replacementHost.resume(opened.sessionId)).toEqual({
        state: "completed",
        value: "approved",
      });
      expect(journalReads).toBe(0);
    });
  });

  it("recovers catalog and route from the journal across Host replacement", async () => {
    const store = sharedApprovalStore();
    const firstHost = fixture(store);
    const replacementHost = fixture(store);
    await run(function* () {
      const opened = yield* firstHost.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "Replace host?" },
        catalog,
        route: { driverKind: "program", acceptedPlacement: "zone-a" },
      });
      expect(yield* opened.result).toMatchObject({ state: "parked" });
      const journal = yield* store.open(opened.sessionId);
      expect((yield* journal.executionState(opened.sessionId, opened.taskId)).executionEpoch).toBe(
        2,
      );
      expect(yield* firstHost.resume(opened.sessionId)).toMatchObject({ state: "parked" });
      expect((yield* journal.executionState(opened.sessionId, opened.taskId)).executionEpoch).toBe(
        2,
      );

      const trace = yield* replacementHost.trace(opened.sessionId);
      expect(trace.tasks[0]?.catalogDigest).toBe(catalog.digest);
      const pull = trace.tasks[0]?.operations[0];
      expect(pull).toBeDefined();
      expect(
        yield* replacementHost.respond({
          sessionId: opened.sessionId,
          taskId: opened.taskId,
          pullId: pull!.pullId,
          response: { action: "accept", content: { approved: true } },
        }),
      ).toEqual({ state: "completed", value: "approved" });
      expect((yield* journal.executionState(opened.sessionId, opened.taskId)).executionEpoch).toBe(
        3,
      );
    });
  });

  it("mints collision-safe session ids across Host instances sharing a store", async () => {
    const store = sharedApprovalStore();
    const firstHost = fixture(store);
    const secondHost = fixture(store);
    await run(function* () {
      const first = yield* firstHost.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "One" },
        catalog,
      });
      const second = yield* secondHost.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "Two" },
        catalog,
      });
      expect(first.sessionId).not.toBe(second.sessionId);
    });
  });

  it("rejects a changed catalog digest before opening a task", async () => {
    const host = fixture();
    await expect(
      run(() =>
        host.open({
          program: pin,
          manifest: approvalProgram.manifest,
          input: { prompt: "Continue?" },
          catalog: { ...catalog, digest: "0".repeat(64) },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("resumes the outermost root when a parked child receives input", async () => {
    const child = createDurableTool("host_child")
      .description("Child")
      .identity({ version: "1", digest: sha256("host-child-v1") })
      .parameters(z.object({}))
      .elicits({ answer: z.object({ value: z.string() }) })
      .effects({})
      .execute(function* (_input, context) {
        const answer = yield* context.elicit("answer", { message: "Answer?" });
        return answer.action === "accept" ? answer.content.value : "declined";
      });
    const childPin = {
      id: child.manifest.programId,
      version: child.manifest.version,
      digest: child.manifest.digest,
    };
    const parent = createDurableTool("host_parent")
      .description("Parent")
      .identity({ version: "1", digest: sha256("host-parent-v1") })
      .parameters(z.object({}))
      .effects({})
      .execute(function* (_input, context) {
        return yield* context.pull({
          kind: "invoke",
          child: { ...childPin, input: {} },
        });
      });
    const parentPin = {
      id: parent.manifest.programId,
      version: parent.manifest.version,
      digest: parent.manifest.digest,
    };
    const programs = createDurableToolRegistry([parent, child]);
    const host = createProgramWorkflowHost({
      journalStore: createProgramDriverJournalStore({
        keyring: createCapabilityKeyring("parent-child-host", [
          { keyId: "active", secret: "parent-child-host-secret-32-bytes" },
        ]),
        schemaRegistry: programDriverSchemaRegistry([
          ...parent.artifacts.catalog,
          ...child.artifacts.catalog,
        ]),
      }),
      programs,
      effects: createDurableEffectRegistry([]),
    });
    const parentCatalog = createPinnedProgramCatalog({
      host_parent: { kind: "program", target: "host_parent", program: parentPin },
      host_child: { kind: "program", target: "host_child", program: childPin },
    });
    await run(function* () {
      const opened = yield* host.open({
        program: parentPin,
        manifest: parent.manifest,
        input: {},
        catalog: parentCatalog,
      });
      expect(yield* opened.result).toMatchObject({ state: "parked", reason: "elicit" });
      const trace = yield* host.trace(opened.sessionId);
      const childTask = trace.tasks.find((task) => task.parentTaskId === opened.taskId)!;
      const elicit = childTask.operations.find(
        (operation) => (operation.descriptor as { kind?: string }).kind === "elicit",
      )!;
      expect(
        yield* host.respond({
          sessionId: opened.sessionId,
          taskId: childTask.taskId,
          pullId: elicit.pullId,
          response: { action: "accept", content: { value: "child-result" } },
        }),
      ).toEqual({ state: "completed", value: "child-result" });
    });
  });

  it("rejects dispatch to a child outside the accepted catalog", async () => {
    const childPin = { id: "missing-child", version: "1", digest: "a".repeat(64) };
    const parent = createDurableTool("catalog_parent")
      .description("Catalog parent")
      .identity({ version: "1", digest: sha256("catalog-parent-v1") })
      .parameters(z.object({}))
      .effects({})
      .execute(function* (_input, context) {
        return yield* context.pull({
          kind: "invoke",
          child: { ...childPin, input: {} },
        });
      });
    const parentPin = {
      id: parent.manifest.programId,
      version: parent.manifest.version,
      digest: parent.manifest.digest,
    };
    const programs = createDurableToolRegistry([parent]);
    const host = createProgramWorkflowHost({
      journalStore: createProgramDriverJournalStore({
        keyring: createCapabilityKeyring("catalog-host", [
          { keyId: "active", secret: "catalog-host-secret-at-least-32!!" },
        ]),
        schemaRegistry: programDriverSchemaRegistry(parent.artifacts.catalog),
      }),
      programs,
      effects: createDurableEffectRegistry([]),
    });
    await run(function* () {
      const opened = yield* host.open({
        program: parentPin,
        manifest: parent.manifest,
        input: {},
        catalog: createPinnedProgramCatalog({
          catalog_parent: { kind: "program", target: "catalog_parent", program: parentPin },
        }),
      });
      let code = "";
      try {
        yield* opened.result;
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("unknown_target");

      const drifted = yield* host.open({
        program: parentPin,
        manifest: parent.manifest,
        input: {},
        catalog: createPinnedProgramCatalog({
          catalog_parent: { kind: "program", target: "catalog_parent", program: parentPin },
          "missing-child": {
            kind: "program",
            target: "missing-child",
            program: { ...childPin, digest: "b".repeat(64) },
          },
        }),
      });
      let driftCode = "";
      try {
        yield* drifted.result;
      } catch (error) {
        driftCode = (error as { code?: string }).code ?? "";
      }
      expect(driftCode).toBe("invalid_descriptor");
    });
  });

  it("routes canonical parked sampling through placement DI", async () => {
    const sampledProgram = createDurableTool("host_sample")
      .description("Sample")
      .identity({ version: "1", digest: sha256("host-sample-v1") })
      .parameters(z.object({}))
      .samples()
      .execute(function* (_input, context) {
        return (yield* context.sample({ prompt: "hello" })).text;
      });
    const programs = createDurableToolRegistry([sampledProgram]);
    const observed: string[] = [];
    const modelSamplingService: ModelSamplingService = {
      *sample(_request, context) {
        observed.push(
          `route:${String((context.placement.route as Record<string, unknown>)["driverKind"])}`,
        );
        observed.push("provider");
        return {
          status: "ok",
          value: {
            message: {
              message: { role: "assistant", content: [{ type: "text", text: "sampled" }] },
              source: null,
              usage: null,
              stopReason: null,
              responseId: null,
              errorMessage: null,
            },
            output: { type: "message" },
          },
        };
      },
    };
    let storedContext: ModelContext | undefined;
    let storedDigest = "";
    const host = createProgramWorkflowHost({
      *modelContextSourceStager(context) {
        const snapshot = canonicalSnapshot(context);
        storedContext = context;
        storedDigest = snapshot.sha;
        return {
          type: "object",
          object: { objectId: "local-host-context" },
          digest: snapshot.sha,
        };
      },
      *modelContextSourceResolver(source) {
        if (
          source.type !== "object" ||
          source.object.objectId !== "local-host-context" ||
          source.digest !== storedDigest ||
          !storedContext
        ) {
          throw new Error("unexpected model context source");
        }
        return storedContext;
      },
      journalStore: createProgramDriverJournalStore({
        keyring: createCapabilityKeyring("local-host-sample-test", [
          { keyId: "active", secret: "local-host-sample-test-secret-32!!" },
        ]),
        schemaRegistry: programDriverSchemaRegistry(sampledProgram.artifacts.catalog),
      }),
      programs,
      effects: createDurableEffectRegistry([]),
      modelSamplingService,
    });
    const samplePin = {
      id: sampledProgram.manifest.programId,
      version: sampledProgram.manifest.version,
      digest: sampledProgram.manifest.digest,
    };
    await run(function* () {
      const opened = yield* host.open({
        program: samplePin,
        manifest: sampledProgram.manifest,
        input: {},
        route: { driverKind: "program", location: "host" },
        catalog: createPinnedProgramCatalog({
          host_sample: { kind: "program", target: "host_sample", program: samplePin },
        }),
      });
      expect(yield* opened.result).toEqual({ state: "completed", value: "sampled" });
      expect(observed).toEqual(["route:program", "provider"]);
      const descriptor = (yield* host.trace(opened.sessionId)).tasks[0]?.operations[0]?.descriptor;
      expect(descriptor).toMatchObject({
        kind: "sample",
        input: {
          invocation: {
            context: {
              type: "object",
              object: { objectId: "local-host-context" },
            },
          },
        },
      });
      expect(JSON.stringify(descriptor)).not.toContain('"messages"');
    });
  });

  it("normalizes cancellation traces to semantic fields only", async () => {
    const host = fixture();
    await run(function* () {
      const opened = yield* host.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "Cancel?" },
        catalog,
      });
      expect(yield* opened.result).toMatchObject({ state: "parked" });
      yield* host.cancel(opened.sessionId, opened.taskId, "user-requested");
      expect((yield* host.trace(opened.sessionId)).tasks[0]?.cancellations).toEqual([
        { taskId: opened.taskId, reason: "user-requested" },
      ]);
    });
  });

  it("creates distinct root turns in one session", async () => {
    const host = fixture();
    await run(function* () {
      const first = yield* host.open({
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "First?" },
        catalog,
      });
      const firstParked = yield* first.result;
      if (firstParked.state !== "parked") {
        throw new Error("expected parked");
      }
      yield* host.respond({
        sessionId: first.sessionId,
        taskId: first.taskId,
        pullId: firstParked.pullId,
        response: { action: "decline" },
      });
      const second = yield* host.open({
        sessionId: first.sessionId,
        program: pin,
        manifest: approvalProgram.manifest,
        input: { prompt: "Second?" },
        catalog,
      });
      expect(second.turnId).toBe("turn-1");
      expect(second.taskId).not.toBe(first.taskId);
      expect((yield* host.trace(first.sessionId)).tasks.map((task) => task.turnId)).toEqual([
        "turn-0",
        "turn-1",
      ]);
    });
  });
});
