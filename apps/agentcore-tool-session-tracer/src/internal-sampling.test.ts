// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeRequest, PROTOCOL_VERSION } from "./protocol.ts";
import {
  parseStructuredSampleText,
  readAgentCoreToolSampleConfig,
  sampleInsideAgentCore,
  selectInternalSampleModel,
} from "./internal-sampling.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AgentCore internal sampling configuration", () => {
  it("defaults to host mode and validates sample mode values", () => {
    expect(readAgentCoreToolSampleConfig({} as NodeJS.ProcessEnv)).toEqual({ mode: "host" });
    expect(
      readAgentCoreToolSampleConfig({
        AGENTCORE_TOOL_SAMPLE_MODE: "internal",
      } as NodeJS.ProcessEnv),
    ).toEqual({ mode: "internal" });
    expect(() =>
      readAgentCoreToolSampleConfig({ AGENTCORE_TOOL_SAMPLE_MODE: "bogus" } as NodeJS.ProcessEnv),
    ).toThrow("AGENTCORE_TOOL_SAMPLE_MODE");
  });

  it("requires explicit internal sample provider and id together", () => {
    expect(() =>
      readAgentCoreToolSampleConfig({
        AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER: "amazon-bedrock",
      } as NodeJS.ProcessEnv),
    ).toThrow("must be set together");
    expect(
      readAgentCoreToolSampleConfig({
        AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER: "amazon-bedrock",
        AGENTCORE_TOOL_SAMPLE_MODEL_ID: "zai.glm-5",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      mode: "host",
      explicitModel: { provider: "amazon-bedrock", id: "zai.glm-5" },
    });
  });

  it("selects explicit sample model before inherited model", () => {
    expect(
      selectInternalSampleModel(
        {
          mode: "internal",
          explicitModel: { provider: "amazon-bedrock", id: "zai.glm-5" },
        },
        { provider: "ollama", id: "qwen3:30b" },
      ),
    ).toEqual({ provider: "amazon-bedrock", id: "zai.glm-5" });

    expect(
      selectInternalSampleModel(
        { mode: "internal" },
        { provider: "amazon-bedrock", id: "zai.glm-5" },
      ),
    ).toEqual({ provider: "amazon-bedrock", id: "zai.glm-5" });
    expect(() => selectInternalSampleModel({ mode: "internal" }, undefined)).toThrow(
      "context.model",
    );
  });

  it("rejects inherited app-local models without host fallback", async () => {
    vi.stubEnv("AGENTCORE_TOOL_SAMPLE_MODE", "internal");
    for (const inheritedModel of [
      { provider: "ollama", id: "qwen3:30b" },
      { provider: "github-copilot", id: "claude-sonnet-4.5" },
    ]) {
      await expect(
        sampleInsideAgentCore({
          inheritedModel,
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toThrow("AGENTCORE_TOOL_SAMPLE_MODE=host");
    }
  });

  it("parses structured sample text with reasoning or markdown wrappers", () => {
    expect(parseStructuredSampleText('{"cell":4}')).toEqual({ cell: 4 });
    expect(
      parseStructuredSampleText('<thinking>I should take center.</thinking>\n{"cell":4}'),
    ).toEqual({ cell: 4 });
    expect(parseStructuredSampleText('```json\n{"cell":4}\n```')).toEqual({ cell: 4 });
    expect(parseStructuredSampleText('Reasoning first. {"cell":4} Done.')).toEqual({ cell: 4 });
  });

  it("accepts structured context.model in start_tool_session protocol", () => {
    expect(
      parseRuntimeRequest({
        op: "start_tool_session",
        protocolVersion: PROTOCOL_VERSION,
        commandId: "cmd",
        toolSessionId: "ts",
        toolName: "simple_result",
        context: { model: { provider: "amazon-bedrock", id: "zai.glm-5" } },
      }),
    ).toMatchObject({ context: { model: { provider: "amazon-bedrock", id: "zai.glm-5" } } });

    expect(() =>
      parseRuntimeRequest({
        op: "start_tool_session",
        protocolVersion: PROTOCOL_VERSION,
        commandId: "cmd",
        toolSessionId: "ts",
        toolName: "simple_result",
        context: { model: { provider: "", id: "zai.glm-5" } },
      }),
    ).toThrow();
  });
});
