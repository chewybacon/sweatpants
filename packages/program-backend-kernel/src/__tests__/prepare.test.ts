import { describe, expect, it, vi } from "vitest";
import { run, scoped, suspend, createSignal } from "effection";
import type { WorkflowKernel, WorkflowProgram } from "@sweatpants/workflow-kernel";
import { prepareWorkflow, type KernelBackendDependencies } from "../index.ts";

const identity = {
  kind: "hoot",
  version: "build-1",
  programFormat: "instructions-1",
  snapshotFormat: "continuation-1",
};
const program: WorkflowProgram = { digest: "program-1", kernel: identity, code: [] };
// Interface double only: tests scope/resource ownership, not evaluator semantics.
function fixture() {
  const kernel = {
    identity,
    start: vi.fn<WorkflowKernel["start"]>(),
    restore: vi.fn<WorkflowKernel["restore"]>(),
    close: vi.fn<WorkflowKernel["close"]>(function* () {}),
  } satisfies WorkflowKernel;
  const options = {
    kernelIdentity: identity,
    createKernel: vi.fn<KernelBackendDependencies["createKernel"]>(function* () {
      return kernel;
    }),
    loadProgram: vi.fn<KernelBackendDependencies["loadProgram"]>(function* () {
      return program;
    }),
  };
  return { kernel, options };
}

describe("scoped workflow preparation", () => {
  it("keeps compute alive in the owning scope and closes on normal exit", async () => {
    const { kernel, options } = fixture();
    await run(function* () {
      const prepared = yield* prepareWorkflow(options, program.digest);
      expect(prepared).toEqual({ kernel, program });
      expect(kernel.close).not.toHaveBeenCalled();
      expect(kernel.start).not.toHaveBeenCalled();
      expect(kernel.restore).not.toHaveBeenCalled();
    });
    expect(kernel.close).toHaveBeenCalledOnce();
  });
  it("closes at the acquiring child scope, not its parent exit", async () => {
    const { kernel, options } = fixture();
    await run(function* () {
      yield* scoped(function* () {
        yield* prepareWorkflow(options, program.digest);
      });
      expect(kernel.close).toHaveBeenCalledOnce();
    });
    expect(kernel.close).toHaveBeenCalledOnce();
  });
  it("releases compute when the host task halts", async () => {
    const { kernel, options } = fixture();
    const task = run(function* () {
      yield* prepareWorkflow(options, program.digest);
      yield* suspend();
    });
    expect(kernel.close).not.toHaveBeenCalled();
    await task.halt();
    expect(kernel.close).toHaveBeenCalledOnce();
    expect(kernel.start).not.toHaveBeenCalled();
  });
  it("waits for asynchronous resource cleanup on scope exit", async () => {
    const { kernel, options } = fixture();
    const signal = createSignal<void>();
    let waiting = false;
    let finished = false;
    kernel.close.mockImplementation(function* () {
      const subscription = yield* signal;
      waiting = true;
      yield* subscription.next();
      finished = true;
    });
    const task = run(function* () {
      yield* prepareWorkflow(options, program.digest);
    });
    expect(waiting).toBe(true);
    expect(finished).toBe(false);
    signal.send();
    await task;
    expect(finished).toBe(true);
  });
  it("rejects the wrong artifact before allocation", async () => {
    const { options } = fixture();
    await expect(run(() => prepareWorkflow(options, "other"))).rejects.toThrow("different program");
    expect(options.createKernel).not.toHaveBeenCalled();
  });
  it("rejects incompatible checkpoint identity before allocation", async () => {
    const { options } = fixture();
    await expect(
      run(() =>
        prepareWorkflow(options, program.digest, {
          kernel: identity,
          programDigest: "other",
          state: {},
        }),
      ),
    ).rejects.toThrow("Snapshot");
    expect(options.createKernel).not.toHaveBeenCalled();
  });
  it("closes an instance with the wrong identity", async () => {
    const { kernel, options } = fixture();
    options.createKernel.mockImplementation(function* () {
      return { ...kernel, identity: { ...identity, version: "wrong" } };
    });
    await expect(run(() => prepareWorkflow(options, program.digest))).rejects.toThrow(
      "different kernel",
    );
    expect(kernel.close).toHaveBeenCalledOnce();
  });
  it("closes after the caller throws", async () => {
    const { kernel, options } = fixture();
    await expect(
      run(function* () {
        yield* prepareWorkflow(options, program.digest);
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(kernel.close).toHaveBeenCalledOnce();
  });
  it("propagates loader failure without allocation", async () => {
    const { options } = fixture();
    options.loadProgram.mockImplementation(function* () {
      throw new Error("artifact unavailable");
    });
    await expect(run(() => prepareWorkflow(options, program.digest))).rejects.toThrow(
      "artifact unavailable",
    );
    expect(options.createKernel).not.toHaveBeenCalled();
  });
  it("propagates allocation failure without closing an unacquired instance", async () => {
    const { kernel, options } = fixture();
    options.createKernel.mockImplementation(function* () {
      throw new Error("wasm unavailable");
    });
    await expect(run(() => prepareWorkflow(options, program.digest))).rejects.toThrow(
      "wasm unavailable",
    );
    expect(kernel.close).not.toHaveBeenCalled();
  });
});
