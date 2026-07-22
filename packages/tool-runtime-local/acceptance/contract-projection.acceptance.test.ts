/**
 * F4: portable tool artifact projection.
 *
 * Worker-backed registration consumes a metadata-only contract projection so
 * the host process never needs the implementation closure. Inline execution
 * rejects projections explicitly. Both derive from one authored definition.
 */
import { run } from "effection";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, isExecutableToolContract, projectToolContract } from "@sweatpants/core";
import { createToolInventoryEntry } from "@sweatpants/framework/chat";
import {
  createInMemoryToolSessionStore,
  createLocalToolRuntimeDriver,
  createToolSessionRegistry,
} from "../src/index.ts";

const workerFixtureCandidates = [
  resolve(process.cwd(), "src/__tests__/fixtures/tool-worker-bootstrap.mjs"),
  resolve(
    process.cwd(),
    "packages/tool-runtime-local/src/__tests__/fixtures/tool-worker-bootstrap.mjs",
  ),
];

const workerFixturePath = (() => {
  const candidate = workerFixtureCandidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error("Failed to resolve tool-worker-bootstrap.mjs fixture path");
  }
  return candidate;
})();

const workerConfig = {
  workerUrl: pathToFileURL(workerFixturePath),
  isDev: false,
} as const;

// The single authored definition. The worker fixture executes `echo`; the
// host below registers only the projection of this definition.
const echoTool = createTool("echo")
  .description("Echo a message")
  .parameters(z.object({ message: z.string() }))
  .execute(function* (params) {
    return { echoed: params.message };
  });

describe("portable tool contract projection (F4)", () => {
  it("projects a non-executable contract preserving identity, schemas, and capabilities", () => {
    const projection = projectToolContract(echoTool);

    expect(projection.name).toBe("echo");
    expect(projection.description).toBe("Echo a message");
    expect(projection.execution).toBe("ordinary");
    expect(projection.parameters).toBe(echoTool.parameters);
    expect(projection.artifacts).toBe(echoTool.artifacts);
    expect(projection.capabilities).toEqual(echoTool.capabilities);

    // The projection is data, not a callable factory.
    expect(typeof projection).toBe("object");
    expect(isExecutableToolContract(projection)).toBe(false);
    expect(isExecutableToolContract(echoTool)).toBe(true);
  });

  it("executes through a worker-backed runtime registered with only the projection", async () => {
    await run(function* () {
      const projection = projectToolContract(echoTool);
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [projection],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: workerConfig },
      });

      const execution = yield* driver.execute({
        entry: createToolInventoryEntry(projection),
        call: {
          id: "call-projected",
          type: "function",
          function: { name: "echo", arguments: { message: "hello projection" } },
        },
        signal: new AbortController().signal,
      });

      expect(execution.kind).toBe("completed");
      if (execution.kind === "completed") {
        expect(execution.result).toEqual({ echoed: "hello projection" });
      }
    });
  });

  it("rejects inline execution of a metadata-only projection with a clear error", async () => {
    await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {});
      const projection = projectToolContract(echoTool);

      let error: Error | undefined;
      try {
        yield* registry.create(projection, { message: "x" });
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toContain("metadata-only contract projection");
      expect(error?.message).toContain("worker mode");
    });
  });

  it("inline execution still works with the full definition", async () => {
    await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {});
      const session = yield* registry.create(echoTool, { message: "inline" });
      const settled = yield* session.settled!();
      expect(settled).toBe("completed");
    });
  });
});
