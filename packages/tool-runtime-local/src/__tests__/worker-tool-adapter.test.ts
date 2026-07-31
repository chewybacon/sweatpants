import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { createWorkerTool } from "../worker-tool-adapter.ts";
import type { WorkerToolContext } from "../worker-types.ts";

const namedOutput = z.object({ answer: z.string() });

const namedSampleTool = createTool("worker_adapter_named_sample")
  .description("Named sample fixture")
  .parameters(z.object({ prompt: z.string() }))
  .samples({ classify: { output: namedOutput } })
  .execute(function* ({ prompt }, ctx) {
    const result = yield* ctx.sample("classify", { prompt });
    return result.parsed;
  });

const elicitingTool = createTool("worker_adapter_elicit")
  .description("Worker elicitation fixture")
  .parameters(z.object({}))
  .elicits({
    confirm: {
      response: z.object({ answer: z.string().trim(), confirmed: z.boolean().default(true) }),
    },
  })
  .execute(function* (_params, ctx) {
    const result = yield* ctx.elicit("confirm", { message: "Confirm this" });
    return result.action === "accept" ? result.content : result;
  });

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

  it("projects a named sample output schema and returns its parsed result", async () => {
    let sampledConfig: unknown;
    const context = {
      signal: new AbortController().signal,
      sample(config: unknown) {
        sampledConfig = config;
        return {
          *[Symbol.iterator]() {
            return {
              text: '{"answer":"typed"}',
              parsed: { answer: "typed" },
              exchange: {
                request: { role: "user", content: "classify" },
                response: { role: "assistant", content: "typed" },
                messages: [],
                parsed: { answer: "typed" },
              },
            };
          },
        };
      },
    } as unknown as WorkerToolContext;
    const workerTool = createWorkerTool(namedSampleTool);

    const result = await run(function* () {
      return yield* workerTool.handler({ prompt: "classify this" }, context);
    });

    expect(sampledConfig).toMatchObject({ prompt: "classify this", schema: namedOutput });
    expect(result).toEqual({ answer: "typed" });
  });

  it("validates worker elicitation completions through the authored response schema", async () => {
    let requestedSchema: unknown;
    const context = {
      signal: new AbortController().signal,
      *elicit(_key: string, options: { schema: unknown }) {
        requestedSchema = options.schema;
        return {
          exchangeId: "worker:req:1",
          action: "accept" as const,
          content: { answer: "  yes  " },
        };
      },
    } as unknown as WorkerToolContext;
    const workerTool = createWorkerTool(elicitingTool);

    const result = await run(function* () {
      return yield* workerTool.handler({}, context);
    });

    expect(requestedSchema).toMatchObject({ type: "object" });
    expect(result).toEqual({ answer: "yes", confirmed: true });
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
