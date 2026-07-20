import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createDurableTool } from "@sweatpants/core";
import {
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createLocalGeneratorDriver,
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
