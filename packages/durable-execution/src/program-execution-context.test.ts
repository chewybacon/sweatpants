import { createProgramExecutionValue, useProgramExecution } from "@sweatpants/durable-execution";
import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  createDurableToolRegistry,
  createLocalProgramDriver,
  createPinnedDurableProgram,
  type AttachProgramRequest,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema";

function fixture(identity: string, role: "program_input" | "program_output") {
  return {
    descriptor: createPortableSchemaDescriptor({
      identity,
      role,
      version: "1",
      vendor: "test",
      inputProjection: true,
      outputProjection: true,
      fidelity: { input: "explicit", output: "explicit" },
    }),
  };
}

const input = fixture("execution-context/input", "program_input");
const output = fixture("execution-context/output", "program_output");
const manifest: DurableProgramManifest = {
  programId: "execution-context-fixture",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: input.descriptor,
  outputSchema: output.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};
const request: AttachProgramRequest = {
  sessionId: "session",
  taskId: "task",
  program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
  input: null,
  route: { driverKind: "program", location: "host" },
  executionEpoch: 7,
  affinity: { kind: "workspace", key: "workspace-binding" },
};

describe("ProgramExecutionContext", () => {
  it("is installed across durable suspensions and derives attempt-local IDs", async () => {
    const observed: unknown[] = [];
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      const before = yield* useProgramExecution();
      observed.push(before);
      const first = before.operationId("ordinary.read");
      yield* context.emit("checkpoint", { first });
      const after = yield* useProgramExecution();
      const second = after.operationId("ordinary.read");
      return { first, second, affinity: after.affinity };
    });
    const driver = createLocalProgramDriver(createDurableToolRegistry([tool]));

    const result = await run(function* () {
      const attachment = yield* driver.attach(request);
      const emission = yield* driver.step(attachment, { type: "start", input: null });
      if (emission.type !== "emission") {
        throw new Error("expected emission");
      }
      const completed = yield* driver.step(attachment, {
        type: "ack_emission",
        actionIndex: emission.actionIndex,
        offset: "1",
      });
      yield* driver.shutdown(attachment, "completed");
      return completed;
    });

    expect(result).toMatchObject({
      type: "completed",
      value: { affinity: { kind: "workspace", key: "workspace-binding" } },
    });
    if (result.type !== "completed") {
      throw new Error("expected completion");
    }
    const value = result.value as { first: string; second: string };
    expect(value.first).not.toBe(value.second);
    expect(value.first.length).toBeLessThanOrEqual(128);
    expect(observed[0]).toMatchObject({
      format: "sweatpants.program-execution.v1",
      identity: { sessionId: "session", taskId: "task" },
      attempt: { executionEpoch: 7, route: request.route },
    });

    const another = createProgramExecutionValue(request, "another-attachment");
    expect(another.operationId("ordinary.read")).not.toBe(value.first);
  });

  it("fails outside an attachment and rejects unbounded namespaces", async () => {
    await expect(
      run(function* () {
        return yield* useProgramExecution();
      }),
    ).rejects.toMatchObject({
      code: "program_execution_unavailable",
    });
    const execution = createProgramExecutionValue(request, "attachment");
    expect(() => execution.operationId(" ")).toThrow(/namespace/);
    expect(() =>
      createProgramExecutionValue(
        { ...request, route: { driverKind: "program", authToken: "must-not-project" } },
        "attachment",
      ),
    ).toThrow(/forbidden authority material/);
  });
});
