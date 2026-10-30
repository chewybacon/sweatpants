// @vitest-environment node
import { expect, it } from "vitest";
import { run } from "effection";
import { createMontyKernel, montyIdentity } from "@sweatpants/flowmode-runtime-monty";
import { loadMontyModule } from "@sweatpants/flowmode-runtime-monty/node";
import { anyioSource } from "@sweatpants/flowmode-runtime-monty/guest";
import { executionServiceFactory } from "../../../apps/yo-workflow/execution/service-core.mjs";
import { createMontyStack } from "../../../apps/yo-workflow/execution/monty.mjs";
import { executionViewSchema } from "../../../apps/yo-workflow/src/execution/contract.ts";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority";

for (const surface of ["anyio", "asyncio"] as const) {
  for (const scenario of ["normal", "guest", "failure", "host"] as const) {
    if (surface === "asyncio" && scenario === "guest") {
      continue;
    }
    it(`public ${surface} nested groups: ${scenario}, genuine snapshots and authorized cleanup`, async () => {
      let source =
        scenario === "host"
          ? anyioSource
          : `import anyio
from sandbox import read_file
async def worker():
    try:
        await read_file("a.txt")
        ${scenario === "failure" ? 'raise ValueError("child failed")' : 'return "ok"'}
    finally:
        with anyio.CancelScope(shield=True):
            await read_file("cleanup-a.txt")
async def main():
    try:
        async with anyio.create_task_group() as outer:
            async with anyio.create_task_group() as inner:
                inner.start_soon(worker)
                await read_file("b.txt")
                ${scenario === "guest" ? "inner.cancel_scope.cancel()" : "pass"}
    except RuntimeError:
        return "child failure drained"
    finally:
        with anyio.CancelScope(shield=True):
            await read_file("session-cleanup.txt")
    return "done"`;
      if (surface === "asyncio") {
        source =
          "import asyncio\n" +
          source
            .replaceAll("anyio.create_task_group()", "asyncio.TaskGroup()")
            .replace("inner.start_soon(worker)", "inner.create_task(worker())")
            .replace('group.start_soon(read_one, "a.txt")', 'group.create_task(read_one("a.txt"))')
            .replace('group.start_soon(read_one, "b.txt")', 'group.create_task(read_one("b.txt"))');
      }
      const store = createMemoryExecutionStore();
      const saved = new Map();
      const { createExecutionService } = executionServiceFactory([
        { ...createMontyStack(loadMontyModule), caller: source },
      ]);
      const service = () =>
        createExecutionService({
          secret: "public-async-acceptance-secret".repeat(3),
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
      const initial = structuredClone(view.operations);
      const command = async (action: string, fields: Record<string, unknown> = {}) => {
        view = executionViewSchema.parse(
          await service().command({ action, id: view.id, revision: view.revision, ...fields }),
        );
      };
      if (scenario === "host") {
        await command("cancel");
        expect(
          view.operations.every((op) => op.request?.arguments.path.startsWith("cleanup-")),
        ).toBe(true);
      }
      const seen: string[] = [];
      let firstSettlement: { revision: number; id: number } | undefined;
      for (let steps = 0; view.operations.length && steps < 12; steps++) {
        const pending = structuredClone(view.operations);
        await command("restore");
        expect(view.restoration?.stateUnchanged).toBe(true);
        expect(view.operations).toEqual(pending);
        expect(JSON.stringify(view.checkpoint)).toContain("monty-dump35-min13-host1");
        if (scenario === "host") {
          await command("cancel");
          expect(view.operations).toEqual(pending);
          await expect(
            command("reply", { operationId: initial[0].id, choice: "late body" }),
          ).rejects.toThrow();
          view = executionViewSchema.parse(await service().get(view.id));
        }
        // Guest cancellation is triggered by the parent reply before child work settles.
        const op = view.operations[0];
        seen.push(op.request!.arguments.path);
        firstSettlement ??= { revision: view.revision, id: op.id };
        await command("reply", { operationId: op.id, choice: "fixture" });
        const checkpoint = structuredClone(view.checkpoint);
        await expect(
          service().command({
            action: "reply",
            id: view.id,
            revision: firstSettlement.revision,
            operationId: firstSettlement.id,
            choice: "duplicate",
          }),
        ).rejects.toThrow("Execution changed");
        expect((await service().get(view.id)).checkpoint).toEqual(checkpoint);
      }
      expect(view.operations).toEqual([]);
      expect(seen).toContain("cleanup-a.txt");
      expect(seen.at(-1)).toBe("session-cleanup.txt");
      expect(view.status).toBe(scenario === "host" ? "cancelled" : "completed");
      if (scenario !== "host") {
        expect(view.result).toMatchObject({
          value: scenario === "failure" ? "child failure drained" : "done",
        });
      }
    });
  }
}

it("public host cancellation survives guest suppression", async () => {
  await run(function* () {
    const kernel = createMontyKernel(loadMontyModule);
    const code = `from sandbox import read_file
async def main():
    try:
        await read_file("a.txt")
    except ValueError:
        return "suppressed"
`;
    try {
      const state = yield* kernel.start(
        { kernel: montyIdentity, digest: "caught-host", code },
        null,
      );
      expect(yield* state.execution.cancel("FIRST")).toEqual({
        kind: "cancelled",
        reason: "FIRST",
      });
    } finally {
      yield* kernel.close();
    }
  });
});
