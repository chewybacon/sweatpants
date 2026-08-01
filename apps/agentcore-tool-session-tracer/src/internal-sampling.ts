import { run } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import { toToolParameterJsonSchema } from "@sweatpants/tool-session/tool-parameters";
import type {
  SampleExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
  SamplingToolDefinition,
} from "@sweatpants/agent-sdk";
import { toModelMessages, type ExtendedMessage } from "@sweatpants/tool-session/messages";
import {
  assistantText,
  parseStructuredSampleText,
  projectSamplingTools,
  samplingToolCalls,
  type ModelSampleToolCall,
} from "@sweatpants/model-sampling";
import {
  createPiAiModelProviderDriver,
  modelSelectionKey,
  resolvePiAiModel,
  type ModelSelection,
} from "../../../packages/model-provider-pi-ai/src/index.ts";
import type {
  AssistantMessage as ModelAssistantMessage,
  Context as ModelContext,
  PortableModelContextMessage,
} from "@sweatpants/model-provider";

export type AgentCoreToolSampleMode = "host" | "internal";

export interface AgentCoreToolSampleConfig {
  mode: AgentCoreToolSampleMode;
  explicitModel?: ModelSelection | undefined;
}

export interface InternalSampleRequest {
  inheritedModel?: ModelSelection | undefined;
  messages: ExtendedMessage[];
  systemPrompt?: string | undefined;
  maxTokens?: number | undefined;
  tools?: unknown[] | undefined;
  toolChoice?: unknown;
  schema?: JsonObject | undefined;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function readAgentCoreToolSampleConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentCoreToolSampleConfig {
  const rawMode = nonEmptyEnv(env["AGENTCORE_TOOL_SAMPLE_MODE"]) ?? "host";
  if (rawMode !== "host" && rawMode !== "internal") {
    throw new Error(`AGENTCORE_TOOL_SAMPLE_MODE must be "host" or "internal"; received ${rawMode}`);
  }

  const provider = nonEmptyEnv(env["AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER"]);
  const id = nonEmptyEnv(env["AGENTCORE_TOOL_SAMPLE_MODEL_ID"]);
  if ((provider && !id) || (!provider && id)) {
    throw new Error(
      "AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER and AGENTCORE_TOOL_SAMPLE_MODEL_ID must be set together",
    );
  }

  return {
    mode: rawMode,
    ...(provider && id ? { explicitModel: { provider, id } } : {}),
  };
}

export function selectInternalSampleModel(
  config: AgentCoreToolSampleConfig,
  inheritedModel: ModelSelection | undefined,
): ModelSelection {
  if (config.explicitModel) {
    return config.explicitModel;
  }
  if (inheritedModel) {
    return inheritedModel;
  }
  throw new Error(
    "AgentCore internal sampling requires start_tool_session.context.model or explicit AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER/ID",
  );
}

function assertAgentCoreUsableModel(selection: ModelSelection): void {
  const appOnlyProviders = new Set(["ollama", "github-copilot"]);
  if (appOnlyProviders.has(selection.provider)) {
    throw new Error(
      `AgentCore internal sampling cannot use app-local model ${modelSelectionKey(selection)}; configure AGENTCORE_TOOL_SAMPLE_MODE=host or set AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER/ID to an AgentCore-reachable model`,
    );
  }
}

function isSchemaToolCall(toolCall: ModelSampleToolCall): boolean {
  return toolCall.name === "__schema__" || toolCall.name === "schema__";
}

function modelContext(
  messages: PortableModelContextMessage[],
  request: InternalSampleRequest,
): ModelContext {
  const context: ModelContext = {
    messages,
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
  };

  const tools = projectSamplingTools(
    request.tools as SamplingToolDefinition[] | undefined,
    (tool) => toToolParameterJsonSchema(tool.inputSchema),
  );
  if (tools) {
    context.tools = tools;
  }
  return context;
}

function rawResultFromAssistant(
  assistant: ModelAssistantMessage,
  model: ModelSelection,
  request: InternalSampleRequest,
): SampleExchangeCompletion {
  const text = assistantText(assistant);
  const toolCalls = samplingToolCalls(assistant);
  const modelName = modelSelectionKey(model);

  if (request.schema) {
    const schemaToolCall = toolCalls.find(isSchemaToolCall);
    if (schemaToolCall) {
      const parsed = schemaToolCall.arguments;
      return {
        text: text || JSON.stringify(parsed),
        model: modelName,
        stopReason: "endTurn",
        parsed,
      } satisfies ParsedSampleExchangeCompletion<unknown>;
    }

    try {
      return {
        text,
        model: modelName,
        stopReason: "endTurn",
        parsed: parseStructuredSampleText(text),
      } satisfies ParsedSampleExchangeCompletion<unknown>;
    } catch (error) {
      return {
        text,
        model: modelName,
        stopReason: "endTurn",
        parsed: null,
        parseError: {
          message: error instanceof Error ? error.message : "Failed to parse JSON",
          rawText: text,
        },
      } satisfies ParsedSampleExchangeCompletion<unknown>;
    }
  }

  if (toolCalls.length > 0) {
    return {
      text,
      model: modelName,
      stopReason: "toolUse",
      toolCalls,
    } satisfies ToolCallSampleExchangeCompletion;
  }

  return {
    text,
    model: modelName,
    stopReason:
      assistant.stopReason === "maxTokens" || assistant.stopReason === "length"
        ? "maxTokens"
        : "endTurn",
  } satisfies SampleExchangeCompletionBase;
}

export async function sampleInsideAgentCore(
  request: InternalSampleRequest,
): Promise<SampleExchangeCompletion> {
  const config = readAgentCoreToolSampleConfig();
  if (config.mode !== "internal") {
    throw new Error(
      "sampleInsideAgentCore called while AGENTCORE_TOOL_SAMPLE_MODE is not internal",
    );
  }

  const selection = selectInternalSampleModel(config, request.inheritedModel);
  assertAgentCoreUsableModel(selection);
  const model = resolvePiAiModel(selection);
  const driver = createPiAiModelProviderDriver();
  const assistant = await run(function* () {
    return yield* driver.sample({
      model,
      context: modelContext(toModelMessages(request.messages), request),
      options: {
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.toolChoice === "auto" ||
        request.toolChoice === "required" ||
        request.toolChoice === "none"
          ? { toolChoice: request.toolChoice }
          : {}),
        ...(request.schema
          ? {
              responseFormat: {
                type: "json_schema" as const,
                name: "agentcore_tool_sample",
                schema: request.schema,
              },
            }
          : {}),
      },
    });
  });

  return rawResultFromAssistant(assistant, selection, request);
}
