import { describe, expect, it } from "vitest";
import { run } from "effection";
import { installModelProvider, ModelProviderApi, ModelProviderPort } from "./index.ts";

describe("model-provider operation port", () => {
  it("fails closed until a provider is installed and dispatches canonical responses", async () => {
    await expect(
      run(function* () {
        yield* ModelProviderApi.operations.sample({
          model: {
            id: "test",
            name: "test",
            api: "test",
            provider: "test",
            reasoning: false,
            input: ["text"],
            contextWindow: 1,
            maxTokens: 1,
          },
          context: { messages: [], tools: [] },
        });
      }),
    ).rejects.toThrow("Model provider not configured");

    await expect(
      run(function* () {
        yield* installModelProvider({
          *stream() {
            throw new Error("unused");
          },
          *sample() {
            return {
              role: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "installed" }] },
              source: null,
              usage: null,
              stopReason: null,
              responseId: null,
              errorMessage: null,
            };
          },
        });
        return yield* ModelProviderApi.operations.sample({
          model: {
            id: "test",
            name: "test",
            api: "test",
            provider: "test",
            reasoning: false,
            input: ["text"],
            contextWindow: 1,
            maxTokens: 1,
          },
          context: { messages: [], tools: [] },
        });
      }),
    ).resolves.toMatchObject({ message: { content: [{ text: "installed" }] } });
    expect(ModelProviderPort).toBeDefined();
  });
});
