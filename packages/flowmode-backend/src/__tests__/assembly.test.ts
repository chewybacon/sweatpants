import { expect, it } from "vitest";
import { run } from "effection";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createKernelProgram, createKernelProgramBundle } from "../index.ts";

it("rejects changed bundle content before acquiring compute or dispatching effects", async () => {
  const identity = { kind: "fixture", version: "1", programFormat: "1", snapshotFormat: "1" };
  const bundle = createKernelProgramBundle({ format: "1", payload: "original" }, identity, {
    programId: "review",
    version: "1",
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    effects: {},
    elicits: {},
    capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
  });
  let acquisitions = 0;
  let dispatches = 0;
  const program = createKernelProgram({
    bundle,
    runtime: {
      kernelIdentity: identity,
      *createKernel() {
        acquisitions++;
        throw Error("Unexpected compute acquisition");
      },
    },
    bindOperation() {
      dispatches++;
      throw Error("Unexpected effect");
    },
  });
  const pinned = { id: "review", version: "1", digest: bundle.artifact.digest };
  const driver = program.createDriver();
  const manifest = await run(() => driver.manifest!(pinned));
  expect(manifest).toEqual(bundle.manifest);
  expect(manifest).not.toBe(bundle.manifest);
  // A runtime caller can alter an object despite TypeScript readonly annotations.
  Object.assign(bundle.artifact, { code: "modified" });
  await expect(run(() => driver.manifest!(pinned))).rejects.toThrow("digest differs");
  await expect(
    run(function* () {
      yield* driver.attach({
        sessionId: "session",
        taskId: "task",
        program: pinned,
        input: null,
        route: { driverKind: "workflow" },
        executionEpoch: 1,
      });
    }),
  ).rejects.toThrow("digest differs");
  expect(acquisitions).toBe(0);
  expect(dispatches).toBe(0);
});
