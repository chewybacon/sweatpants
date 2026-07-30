import { describe, expect, it } from "vitest";
import { run } from "effection";
import {
  installModelProvider,
  ModelProviderApi,
  ModelProviderPort,
  type Message,
} from "./index.ts";

describe("model-provider contract", () => {
  it("owns protocol-neutral model messages", () => {
    const message: Message = { role: "user", content: "hello" };
    expect(message).toEqual({ role: "user", content: "hello" });
  });

  it("fails closed until a provider is installed and dispatches after installation", async () => {
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
          context: { messages: [] },
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
            return { role: "assistant", content: [{ type: "text", text: "installed" }] };
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
          context: { messages: [] },
        });
      }),
    ).resolves.toMatchObject({ content: [{ text: "installed" }] });
    expect(ModelProviderPort).toBeDefined();
  });
});
