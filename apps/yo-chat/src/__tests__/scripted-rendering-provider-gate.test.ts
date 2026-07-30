import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "effection";

function mockEnv(scriptedRenderingProvider: "yes" | undefined) {
  vi.doMock("@/env", () => ({
    env: {
      DEFAULT_CHAT_MODEL_PROVIDER: "github-copilot",
      DEFAULT_CHAT_MODEL_ID: "claude-sonnet-4.5",
      ALLOWED_CHAT_MODELS_JSON: undefined,
      UNSAFE_ALLOW_ANY_CHAT_MODEL: undefined,
      ENABLE_SCRIPTED_RENDERING_PROVIDER: scriptedRenderingProvider,
    },
  }));
}

describe("scripted rendering provider gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/env");
  });

  it("rejects scripted rendering requests unless the explicit test provider flag is enabled", async () => {
    mockEnv(undefined);
    const { setupYoChatModelProvider } = await import("../server/model-provider");

    await expect(
      run(function* () {
        yield* setupYoChatModelProvider({
          request: new Request("http://localhost/api/chat?scripted=rendering"),
          body: {} as never,
        });
      }),
    ).rejects.toThrow(/Scripted rendering provider is disabled/);
  });

  it("installs the scripted rendering provider when explicitly enabled", async () => {
    mockEnv("yes");
    const { setupYoChatModelProvider } = await import("../server/model-provider");
    const { useModel } = await import("@sweatpants/model-provider");

    await run(function* () {
      yield* setupYoChatModelProvider({
        request: new Request("http://localhost/api/chat?scripted=rendering"),
        body: {} as never,
      });
      const model = yield* useModel();
      expect(model).toMatchObject({ id: "scripted-rendering", provider: "scripted-e2e" });
    });
  });
});
