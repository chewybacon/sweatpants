import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority";
import { loadMontyModule } from "@sweatpants/flowmode-runtime-monty/node";
import { executionServiceFactory } from "../../../apps/yo-workflow/execution/service-core.mjs";
import { createMontyStack } from "../../../apps/yo-workflow/execution/monty.mjs";
import { executionViewSchema } from "../../../apps/yo-workflow/src/execution/contract.ts";

const steps = ["1. Reserve username", "2. Create pending account", "3. Save profile"];
const records = ["username reservation", "pending account", "profile"];

async function signup() {
  const store = createMemoryExecutionStore();
  const saved = new Map();
  const { createExecutionService } = executionServiceFactory([createMontyStack(loadMontyModule)]);
  const service = () =>
    createExecutionService({
      secret: "signup-acceptance-secret".repeat(3),
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
    await service().command({
      action: "start",
      language: "monty",
      example: "signup",
    }),
  );
  return {
    get view() {
      return view;
    },
    async command(action: string, fields: Record<string, unknown> = {}) {
      view = executionViewSchema.parse(
        await service().command({
          action,
          id: view.id,
          revision: view.revision,
          ...fields,
        }),
      );
    },
    async reply(label: string) {
      expect(view.operations.map((op) => op.label)).toEqual([label]);
      view = executionViewSchema.parse(
        await service().command({
          action: "reply",
          id: view.id,
          revision: view.revision,
          operationId: view.operations[0].id,
          choice: "completed",
        }),
      );
    },
  };
}

describe("Execution signup compensation with actual Wasm and journal recovery", () => {
  it("keeps all records on activation without requesting rollback", async () => {
    const run = await signup();
    for (const label of [...steps, "Activate account (keep all records)"]) {
      await run.command("restore");
      expect(run.view.restoration?.stateUnchanged).toBe(true);
      await run.reply(label);
    }
    expect(run.view.status).toBe("completed");
    expect(run.view.result).toEqual({
      state: "completed",
      value: { status: "active", retained_records: records },
    });
    expect(run.view.operations).toEqual([]);
  });

  for (const completed of [0, 1, 2, 3]) {
    it(`undoes only ${completed} acknowledged records, restoring during rollback`, async () => {
      const run = await signup();
      for (const label of steps.slice(0, completed)) {
        await run.reply(label);
      }
      const staleId = run.view.operations[0].id;
      await run.command("cancel");
      for (const record of records.slice(0, completed).reverse()) {
        const pending = structuredClone(run.view.operations);
        await run.command("cancel");
        expect(run.view.operations).toEqual(pending);
        expect(run.view.operations[0].id).not.toBe(staleId);
        await run.command("restore");
        expect(run.view.restoration?.stateUnchanged).toBe(true);
        await run.reply("Undo: remove " + record);
      }
      expect(run.view.status).toBe("cancelled");
      expect(run.view.operations).toEqual([]);
    });
  }
});
