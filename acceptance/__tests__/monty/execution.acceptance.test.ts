import { describe, it, expect } from "vitest";
import { run } from "effection";
import { createMontyKernel, montyIdentity } from "@sweatpants/flowmode-runtime-monty";
import { loadMontyModule } from "@sweatpants/flowmode-runtime-monty/node";
import { demoSource } from "@sweatpants/flowmode-runtime-monty/guest";
import { executionServiceFactory } from "../../../apps/yo-workflow/execution/service-core.mjs";
import { createMontyStack } from "../../../apps/yo-workflow/execution/monty.mjs";
import { executionViewSchema } from "../../../apps/yo-workflow/src/execution/contract.ts";
import { z } from "zod";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority";

const operations = z.object({
  operations: z.array(z.object({ id: z.number(), label: z.string() })),
});
const program = { code: demoSource, digest: "acceptance", kernel: montyIdentity };

describe("Python workflow authoring through actual Monty Wasm", () => {
  it("keeps concurrent calls outstanding and restores every external turn in a fresh instance", async () => {
    await run(function* () {
      let kernel = createMontyKernel(loadMontyModule);
      let state = yield* kernel.start(program, null);
      try {
        if (state.boundary.kind !== "suspended") {
          throw Error("Expected waiting workflow");
        }
        expect(
          operations.parse(state.boundary.request.input).operations.map((op) => op.label),
        ).toEqual(["Review draft A", "Review draft B"]);
        for (const label of [
          "Review draft B",
          "Release draft B",
          "Review draft A",
          "Release draft A",
          "Finish parent cleanup",
        ]) {
          const snapshot = yield* state.execution.capture();
          const before = JSON.stringify(snapshot);
          yield* kernel.close();
          kernel = createMontyKernel(loadMontyModule);
          state = yield* kernel.restore(program, snapshot);
          expect(JSON.stringify(yield* state.execution.capture())).toBe(before);
          expect(JSON.stringify(snapshot)).toBe(before);
          if (state.boundary.kind !== "suspended") {
            throw Error("Expected waiting workflow");
          }
          const op = operations
            .parse(state.boundary.request.input)
            .operations.find((candidate) => candidate.label === label)!;
          expect(op).toBeDefined();
          const boundary = yield* state.execution.resume(state.boundary.suspensionId, {
            kind: "value",
            value: { operationId: op.id, value: label },
          });
          state = { ...state, boundary };
        }
        expect(state.boundary).toEqual({
          kind: "completed",
          value: ["Review draft A", "Review draft B"],
        });
      } finally {
        yield* kernel.close();
      }
    });
  });
  it("authors bounded queue backpressure and gather without private runtime calls", async () => {
    const source = `async def produce(queue):
    await queue.put("first")
    await queue.put("second")
    return "produced"

async def consume(queue):
    await operation("Read queued items")
    return [await queue.get(), await queue.get()]

async def workflow():
    queue = Queue(1)
    return await gather(produce(queue), consume(queue))
`;
    await run(function* () {
      const queueProgram = { ...program, code: source };
      let kernel = createMontyKernel(loadMontyModule);
      try {
        let state = yield* kernel.start(queueProgram, null);
        const snapshot = yield* state.execution.capture();
        yield* kernel.close();
        kernel = createMontyKernel(loadMontyModule);
        state = yield* kernel.restore(queueProgram, snapshot);
        if (state.boundary.kind !== "suspended") {
          throw Error("Expected host operation");
        }
        const pending = operations.parse(state.boundary.request.input).operations;
        expect(pending.map((op) => op.label)).toEqual(["Read queued items"]);
        expect(
          yield* state.execution.resume(state.boundary.suspensionId, {
            kind: "value",
            value: { operationId: pending[0].id, value: "read" },
          }),
        ).toEqual({ kind: "completed", value: ["produced", ["first", "second"]] });
      } finally {
        yield* kernel.close();
      }
    });
  });
  it("journal-authorizes reverse replies and cancellation while child cleanup is pending", async () => {
    const store = createMemoryExecutionStore();
    const saved = new Map();
    const { createExecutionService } = executionServiceFactory([createMontyStack(loadMontyModule)]);
    const service = () =>
      createExecutionService({
        secret: "monty-acceptance-secret".repeat(3),
        storeFactory: () => store,
        persistence: {
          async load(id) {
            return saved.get(id);
          },
          async save(id, value) {
            saved.set(id, structuredClone(value));
          },
        },
      });
    let view = executionViewSchema.parse(
      await service().command({ action: "start", language: "monty" }),
    );
    expect(view.operations.map((op) => op.label)).toEqual(["Review draft A", "Review draft B"]);
    const command = async (action: string, fields: Record<string, unknown> = {}) => {
      view = executionViewSchema.parse(
        await service().command({ action, id: view.id, revision: view.revision, ...fields }),
      );
      return view;
    };
    const reply = async (label: string) => {
      const op = view.operations.find((candidate) => candidate.label === label);
      expect(op).toBeDefined();
      await command("reply", { operationId: op!.id, choice: label });
    };
    const beforeInvalidReply = JSON.stringify(view.checkpoint);
    await expect(
      command("reply", { operationId: view.operations[0].id, choice: 42 }),
    ).rejects.toThrow("schema_validation_failed");
    view = executionViewSchema.parse(await service().get(view.id));
    expect(JSON.stringify(view.checkpoint)).toBe(beforeInvalidReply);
    const originalRevision = view.revision;
    const originalB = view.operations[1].id;
    await reply("Review draft B");
    await expect(
      service().command({
        action: "reply",
        id: view.id,
        revision: originalRevision,
        operationId: originalB,
        choice: "duplicate",
      }),
    ).rejects.toThrow("Execution changed");
    expect(view.operations.map((op) => op.label)).toEqual(["Review draft A", "Release draft B"]);
    await command("restore");
    expect(view.restoration!.stateUnchanged).toBe(true);
    await command("cancel");
    expect(view.operations.map((op) => op.label)).toEqual(["Release draft B", "Release draft A"]);
    const pending = structuredClone(view.operations);
    await command("cancel");
    expect(view.operations).toEqual(pending);
    await reply("Release draft B");
    expect(view.operations.map((op) => op.label)).toEqual(["Release draft A"]);
    await command("cancel");
    await command("restore");
    await reply("Release draft A");
    expect(view.operations.map((op) => op.label)).toEqual(["Finish parent cleanup"]);
    await command("cancel");
    await reply("Finish parent cleanup");
    expect(view.status).toBe("cancelled");
    expect(view.operations).toEqual([]);
    await expect(command("reply", { operationId: pending[0].id, choice: "late" })).rejects.toThrow(
      "not waiting",
    );
    expect((await service().get(view.id)).status).toBe("cancelled");
  });
});
