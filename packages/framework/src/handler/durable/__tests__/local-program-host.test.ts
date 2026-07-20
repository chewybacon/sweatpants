import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createDurableTool } from "@sweatpants/core";
import {
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createLocalGeneratorDriver,
  createModelSamplingEffectRegistration,
  createModelSamplingRouter,
  createProgramDriverRegistry,
  sha256,
} from "@sweatpants/session-contract";
import { z } from "zod";

import {
  createLocalProgramHost,
  createPinnedProgramCatalog,
} from "../local-program-host.ts";
import {
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
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

function fixture() {
  const programs = createDurableToolRegistry([approvalProgram]);
  const effects = createDurableEffectRegistry([]);
  return createLocalProgramHost({
    journalStore: createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("local-host-test", [
        { keyId: "active", secret: "local-host-test-secret-32-bytes!!" },
      ]),
      schemaRegistry: programDriverSchemaRegistry(approvalProgram.artifacts.catalog),
    }),
    programs,
    effects,
    drivers: createProgramDriverRegistry([["generator", createLocalGeneratorDriver(programs)]]),
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

describe("LocalProgramHost", () => {
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

  it("routes canonical sampling through placement DI and acknowledges only after journal acceptance", async () => {
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
    const router = createModelSamplingRouter({
      policy: (placement) => {
        observed.push(`route:${String((placement.route as Record<string, unknown>)["driverKind"])}`);
        return { ownership: "host" };
      },
      host: {
        *sample() {
          observed.push("provider");
          return { status: "ok", value: { text: "sampled", calls: [], content: [] } };
        },
      },
    });
    const host = createLocalProgramHost({
      journalStore: createInMemoryProgramDriverJournalStore({
        keyring: createCapabilityKeyring("local-host-sample-test", [
          { keyId: "active", secret: "local-host-sample-test-secret-32!!" },
        ]),
        schemaRegistry: programDriverSchemaRegistry(sampledProgram.artifacts.catalog),
      }),
      programs,
      effects: createDurableEffectRegistry([createModelSamplingEffectRegistration()]),
      drivers: createProgramDriverRegistry([["generator", createLocalGeneratorDriver(programs)]]),
      modelSamplingRouter: router,
      modelSamplingOutcomeAcknowledger: function* ({ outcomeDigest }) {
        expect(outcomeDigest).toMatch(/^[0-9a-f]{64}$/);
        observed.push("acknowledged");
      },
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
        route: { driverKind: "generator", location: "host" },
        catalog: createPinnedProgramCatalog({
          host_sample: { kind: "program", target: "host_sample", program: samplePin },
        }),
      });
      expect(yield* opened.result).toEqual({ state: "completed", value: "sampled" });
      expect(observed).toEqual(["route:generator", "provider", "acknowledged"]);
      expect((yield* host.trace(opened.sessionId)).tasks[0]?.operations[0]?.descriptor)
        .toMatchObject({ kind: "effect", name: "model.sample" });
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
      if (firstParked.state !== "parked") throw new Error("expected parked");
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
