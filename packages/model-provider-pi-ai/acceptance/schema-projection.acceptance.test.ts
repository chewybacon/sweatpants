import { run } from "effection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPiAiRuntime } from "../src/runtime/pi-ai.ts";
import type { Context, Model } from "../src/runtime/types.ts";

const piAiMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  generateImages: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: piAiMocks.streamSimple,
  generateImages: piAiMocks.generateImages,
}));

const testModel: Model = {
  id: "zai.glm-5",
  name: "GLM 5",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function mockPiStream(): void {
  piAiMocks.streamSimple.mockReturnValue({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          return { done: true, value: undefined };
        },
      };
    },
    result: vi.fn(async () => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "done" }],
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "zai.glm-5",
      stopReason: "stop" as const,
      timestamp: 1,
    })),
  });
}

beforeEach(() => {
  piAiMocks.streamSimple.mockReset();
  piAiMocks.generateImages.mockReset();
  mockPiStream();
});

describe("@sweatpants/model-provider-pi-ai schema projection acceptance", () => {
  it("sends clone-safe tool JSON Schema with required fields preserved", async () => {
    const runtime = createPiAiRuntime();
    const context: Context = {
      messages: [{ role: "user", content: "Book a flight from Boston to NYC" }],
      tools: [
        {
          name: "book_flight",
          description: "Book a flight",
          parameters: z.object({
            from: z.string(),
            destination: z.string(),
          }) as unknown as Record<string, unknown>,
        },
      ],
    };

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, context);
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    expect(piAiMocks.streamSimple).toHaveBeenCalledTimes(1);
    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    const schema = piContext.tools[0].parameters;

    expect(schema).toMatchObject({
      type: "object",
      properties: {
        from: { type: "string" },
        destination: { type: "string" },
      },
      required: ["from", "destination"],
    });
    expect((schema as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(() => structuredClone({ tools: piContext.tools })).not.toThrow();
  });
});
