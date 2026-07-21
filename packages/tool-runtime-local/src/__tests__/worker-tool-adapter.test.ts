import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import { createWorkerTool } from "../worker-tool-adapter.ts";
import type { WorkerToolContext } from "../worker-types.ts";

const canonicalTool = createTool("worker_adapter_echo")
  .description("Worker adapter fixture")
  .parameters(z.object({ message: z.string() }))
  .execute(function* ({ message }, ctx) {
    return { echoed: message, messageCount: ctx.messages.length };
  });

// This fixture tool does not use context capabilities. The adapter owns the
// actual transport-context conversion; its behavior is covered by the existing
// worker-backed runtime integration tests.
const unusedContext = {} as WorkerToolContext;

describe("createWorkerTool", () => {
  it("invokes a canonical authored tool through the worker protocol", async () => {
    const workerTool = createWorkerTool(canonicalTool);

    const result = await run(function* () {
      return yield* workerTool.handler({ message: "hello" }, unusedContext);
    });

    expect(workerTool.name).toBe("worker_adapter_echo");
    expect(result).toEqual({ echoed: "hello", messageCount: 0 });
  });

  it("retains canonical parameter validation", async () => {
    const workerTool = createWorkerTool(canonicalTool);

    await expect(
      run(function* () {
        return yield* workerTool.handler({ message: 42 }, unusedContext);
      }),
    ).rejects.toMatchObject({ code: "invalid_tool_input" });
  });
});
