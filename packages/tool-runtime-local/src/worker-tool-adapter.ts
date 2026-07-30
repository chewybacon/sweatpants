import type { RuntimeTool } from "@sweatpants/agent-sdk";
import { requireJsonObject, type JsonObject } from "@sweatpants/foundation";
import type {
  LogLevel,
  NamedSampleResult,
  SampleExchange,
  SampleRequest,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleSchemaConfig,
  SampleSchemaConfigMessages,
  SampleSchemaResult,
  SampleToolsResult,
  ToolMessage,
  ToolSampleConfig,
} from "@sweatpants/agent-sdk/tool";
import type { Operation } from "effection";
import type {
  WorkerSampleConfig,
  WorkerSampleSchemaConfig,
  WorkerSampleSchemaConfigMessages,
  WorkerSampleToolsConfig,
  WorkerSampleToolsConfigMessages,
  SampleResultBase as WorkerSampleResultBase,
  SampleResultWithParsed as WorkerSampleResultWithParsed,
  SampleResultWithToolCalls as WorkerSampleResultWithToolCalls,
  SampleSchemaResult as WorkerSampleSchemaResult,
  SampleToolsResult as WorkerSampleToolsResult,
  WorkerTool,
  WorkerToolContext,
} from "./worker-types.ts";

type CanonicalRuntimeContext = Parameters<RuntimeTool>[0];
type CanonicalSampleResult =
  | SampleResultBase
  | SampleResultWithParsed<unknown>
  | SampleResultWithToolCalls;

/**
 * Adapts one canonical authored tool contract to the worker runner protocol.
 *
 * Worker transport types intentionally remain separate from core authoring
 * types. This adapter constructs the complete canonical context explicitly:
 * tool-local messages, named and generic sampling, elicitation, notification,
 * logging, and cancellation. No WorkerToolContext is cast to ToolCtx.
 */
export function createWorkerTool(tool: RuntimeTool): WorkerTool {
  const elicitSchemas: Record<string, JsonObject> = {};
  for (const [key, artifact] of Object.entries(tool.artifacts.elicits)) {
    const {
      $id: _id,
      $schema: _schema,
      ...schema
    } = requireJsonObject(
      artifact.response.inputProjection,
      `tool ${tool.name} elicitation ${key} response`,
    );
    elicitSchemas[key] = schema;
  }
  return {
    name: tool.name,
    elicitSchemas,
    handler: function* (params: unknown, workerContext: WorkerToolContext) {
      const canonicalContext = createCanonicalWorkerContext(tool, workerContext);
      const invoke = yield* tool(canonicalContext);
      return yield* invoke(params);
    },
  };
}

function createCanonicalWorkerContext(
  tool: RuntimeTool,
  worker: WorkerToolContext,
): CanonicalRuntimeContext {
  const messages: ToolMessage[] = [];

  function track(exchange: { messages: ToolMessage[] }, automatic: boolean): void {
    if (automatic) {
      messages.push(...exchange.messages);
    }
  }

  function canonicalSample(config: ToolSampleConfig): Operation<CanonicalSampleResult>;
  function canonicalSample(request: SampleRequest): Operation<NamedSampleResult>;
  function canonicalSample(key: string, request: SampleRequest): Operation<NamedSampleResult>;
  function canonicalSample(
    keyOrRequest: string | ToolSampleConfig | SampleRequest,
    namedRequest?: SampleRequest,
  ): Operation<CanonicalSampleResult | NamedSampleResult> {
    const named = typeof keyOrRequest === "string";
    const request = named ? namedRequest : keyOrRequest;
    if (!request) {
      throw new Error("named sample requires a request");
    }
    const namedOutput = named ? namedSampleOutput(tool, keyOrRequest) : undefined;
    const config = withNamedOutputSchema(
      isToolSampleConfig(request)
        ? toWorkerSampleConfig(request)
        : sampleRequestToWorkerConfig(request),
      namedOutput,
    );
    const automatic = "prompt" in config;

    return {
      *[Symbol.iterator]() {
        const result = yield* worker.sample(config);
        const canonical = canonicalizeSampleResult(config, result);
        track(canonical.exchange, automatic);
        if (!named && isToolSampleConfig(request)) {
          return canonical;
        }
        const namedResult: NamedSampleResult = {
          text: canonical.text,
          ...(canonical.model !== undefined ? { model: canonical.model } : {}),
          ...(canonical.stopReason !== undefined ? { stopReason: canonical.stopReason } : {}),
          exchange: rawExchange(promptText(config), canonical.text),
          content: canonical.text,
          ...("parsed" in canonical ? { parsed: canonical.parsed } : {}),
          raw: result,
        };
        return namedResult;
      },
    };
  }

  const sample = canonicalSample as CanonicalRuntimeContext["sample"];

  const context: CanonicalRuntimeContext = {
    signal: worker.signal,
    get messages() {
      return messages;
    },
    notify(message: string, progress?: number, level?: LogLevel): Operation<void> {
      return worker.notify(message, progress, level);
    },
    log(level: LogLevel, message: string): Operation<void> {
      return worker.log(level, message);
    },
    sample,
    *sampleTools(config): Operation<SampleToolsResult> {
      const result = yield* worker.sampleTools(toWorkerToolsConfig(config));
      const canonical = canonicalizeToolsResult(config, result);
      track(canonical.exchange, "prompt" in config);
      return canonical;
    },
    *sampleSchema<T>(
      config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>,
    ): Operation<SampleSchemaResult<T>> {
      const result = yield* worker.sampleSchema<T>(toWorkerSchemaConfig(config));
      const canonical = canonicalizeSchemaResult(config, result);
      track(canonical.exchange, "prompt" in config);
      return canonical;
    },
    *elicit(key, request) {
      const result = yield* worker.elicit(key, {
        message: request.message,
        ...("context" in request && isRecord(request.context) ? { context: request.context } : {}),
      });
      if (result.action === "accept") {
        messages.push(...result.exchange.messages);
      }
      return result;
    },
  };
  return context;
}

function namedSampleOutput(tool: RuntimeTool, key: string): unknown {
  const definition = (tool.samples as Readonly<Record<string, { output?: unknown }>>)[key];
  if (!definition) {
    throw new Error(`Named sample "${key}" is not declared by tool "${tool.name}"`);
  }
  return definition.output;
}

function withNamedOutputSchema(config: WorkerSampleConfig, output: unknown): WorkerSampleConfig {
  if (output === undefined) {
    return config;
  }
  return { ...config, schema: output } as WorkerSampleConfig;
}

function isToolSampleConfig(value: ToolSampleConfig | SampleRequest): value is ToolSampleConfig {
  return "prompt" in value || "messages" in value;
}

function toWorkerSampleConfig(config: ToolSampleConfig): WorkerSampleConfig {
  if ("prompt" in config) {
    return { ...config, prompt: config.prompt } as WorkerSampleConfig;
  }
  return { ...config, messages: [...config.messages] } as WorkerSampleConfig;
}

function sampleRequestToWorkerConfig(request: SampleRequest): WorkerSampleConfig {
  const options = request.options ?? {};
  const history = request.exchanges?.flatMap((exchange) => [...exchange.messages]) ?? [];
  if (request.prompt !== undefined && history.length === 0) {
    return { prompt: request.prompt, ...sampleOptions(options) };
  }
  const explicit = request.messages ? [...request.messages] : [];
  const messages = [
    ...history,
    ...explicit,
    ...(request.prompt !== undefined
      ? [{ role: "user" as const, content: [{ type: "text" as const, text: request.prompt }] }]
      : []),
  ];
  if (messages.length === 0) {
    throw new Error("sample request requires prompt, messages, or exchanges");
  }
  return { messages, ...sampleOptions(options) } as WorkerSampleConfig;
}

interface WorkerSampleOptions {
  systemPrompt?: string;
  maxTokens?: number;
}

function sampleOptions(options: Readonly<Record<string, unknown>>): WorkerSampleOptions {
  return {
    ...(typeof options["systemPrompt"] === "string"
      ? { systemPrompt: options["systemPrompt"] }
      : {}),
    ...(typeof options["maxTokens"] === "number" ? { maxTokens: options["maxTokens"] } : {}),
  };
}

function canonicalizeSampleResult(
  config: WorkerSampleConfig,
  result: AwaitedWorkerSample,
): CanonicalSampleResult {
  const exchange = rawExchange(promptText(config), result.text);
  if ("parsed" in result) {
    return { ...result, exchange } as SampleResultWithParsed<unknown>;
  }
  if ("toolCalls" in result) {
    return { ...result, exchange } as SampleResultWithToolCalls;
  }
  return { ...result, exchange } as SampleResultBase;
}

type AwaitedWorkerSample =
  | WorkerSampleResultBase
  | WorkerSampleResultWithParsed<unknown>
  | WorkerSampleResultWithToolCalls;

function canonicalizeToolsResult(
  config: { prompt: string } | { messages: readonly unknown[] },
  result: WorkerSampleToolsResult,
): SampleToolsResult {
  return { ...result, exchange: rawExchange(promptText(config), result.text) };
}

function canonicalizeSchemaResult<T>(
  config: { prompt: string } | { messages: readonly unknown[] },
  result: WorkerSampleSchemaResult<T>,
): SampleSchemaResult<T> {
  return {
    ...result,
    exchange: { ...rawExchange(promptText(config), result.text), parsed: result.parsed },
  };
}

/**
 * Canonical exchange summaries intentionally project the effective prompt and
 * result text. Multi-message payloads remain authoritative on the transport;
 * this compact pair is for tool-local history/display accumulation.
 */
function rawExchange(prompt: string, text: string): SampleExchange<undefined> {
  const request: ToolMessage & { role: "user" } = {
    role: "user",
    content: { type: "text", text: prompt },
  };
  const response: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: { type: "text", text },
  };
  return { request, response, messages: [request, response] };
}

function promptText(config: { prompt: string } | { messages: readonly unknown[] }): string {
  if ("prompt" in config) {
    return config.prompt;
  }
  const last = config.messages.at(-1);
  if (typeof last !== "object" || last === null || !("content" in last)) {
    return "";
  }
  const content = (last as { content: unknown }).content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function toWorkerToolsConfig(
  config: Parameters<CanonicalRuntimeContext["sampleTools"]>[0],
): WorkerSampleToolsConfig | WorkerSampleToolsConfigMessages {
  return {
    ...config,
    ...(config.messages ? { messages: [...config.messages] } : {}),
  } as WorkerSampleToolsConfig | WorkerSampleToolsConfigMessages;
}

function toWorkerSchemaConfig<T>(
  config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>,
): WorkerSampleSchemaConfig<T> | WorkerSampleSchemaConfigMessages<T> {
  return {
    ...config,
    ...(config.messages ? { messages: [...config.messages] } : {}),
  } as WorkerSampleSchemaConfig<T> | WorkerSampleSchemaConfigMessages<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
