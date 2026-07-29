// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { run } from "effection";
import type * as AgentCoreModule from "@sweatpants/tool-runtime-agentcore";

describe("yo-chat AgentCore runtime smoke", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("configures AgentCore runtime and executes a remote tool without a separate approval env var", async () => {
    const actualAgentCore = await vi.importActual<typeof AgentCoreModule>(
      "@sweatpants/tool-runtime-agentcore",
    );
    const fakeRuntime = new actualAgentCore.FakeAgentCoreRemoteToolRuntimeClient();

    vi.doMock("@/env", () => ({
      env: {
        MCP_TOOL_RUNTIME: "agentcore",
        AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
        AGENTCORE_REGION: "us-east-1",
        AGENTCORE_ENDPOINT_NAME: "DEFAULT",
        AGENTCORE_RUNTIME_PROFILE_NAME: "yo-chat-agentcore",
        AGENTCORE_TOOL_SESSION_TTL_MS: 60_000,
        AGENTCORE_REDIS_KEY_PREFIX: "sp:test:agentcore:",
        AGENTCORE_TOOL_NAMES: undefined,
        DEFAULT_CHAT_MODEL_PROVIDER: "ollama",
        DEFAULT_CHAT_MODEL_ID: "gemma4:12b-mlx",
      },
    }));

    vi.doMock("@/lib/shared-redis", () => ({
      getSharedRedisClient: async () => null,
    }));

    vi.doMock("../server/tool-worker.ts?modulePath", () => ({
      default: "file:///tmp/tool-worker.js",
    }));

    vi.doMock("../server/tools", () => ({
      activeAgentCoreToolNames: () => ["book_flight"],
      activePluginTools: [
        {
          name: "book_flight",
          description: "Book a flight",
          parameters: { type: "object", properties: {} },
        },
      ],
      allTools: [
        {
          name: "book_flight",
          description: "Book a flight",
          parameters: { type: "object", properties: {} },
        },
      ],
    }));

    vi.doMock("@sweatpants/tool-runtime-agentcore", async () => {
      const actual = await vi.importActual<typeof AgentCoreModule>(
        "@sweatpants/tool-runtime-agentcore",
      );
      return {
        ...actual,
        createAwsSdkAgentCoreInvoker: () => ({
          invoke: async () => {
            throw new Error("unexpected live AgentCore invocation in smoke test");
          },
        }),
        createAgentCoreRemoteToolRuntimeClient: () => fakeRuntime,
      };
    });

    const { setupYoChatPluginsAndRuntime } = await import("../server/tool-runtime");
    const { ToolInventoryApi } = await import("@sweatpants/chat-core");
    const { ToolRuntimeApi } = await import("@sweatpants/tool-session/chat-runtime");
    const { ProgramDriverForeignEffectsContext } =
      await import("@sweatpants/durable-chat-runtime/durable-handler");

    await run(function* () {
      yield* setupYoChatPluginsAndRuntime();

      const foreignEffects = yield* ProgramDriverForeignEffectsContext.get();
      expect(foreignEffects).toHaveLength(2);

      const inventory = yield* ToolInventoryApi.list();
      expect(inventory.some((tool) => tool.definition.name === "book_flight")).toBe(true);

      const entry = yield* ToolInventoryApi.resolve("book_flight");
      const result = yield* ToolRuntimeApi.operations.execute({
        entry,
        call: {
          id: "call-book-flight",
          type: "function",
          function: {
            name: "book_flight",
            arguments: { destination: "Paris" },
          },
        },
      });

      expect(result).toMatchObject({ kind: "completed" });
    });
  }, 15_000);
});
