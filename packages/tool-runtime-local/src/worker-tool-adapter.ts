import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import { requireJsonObject, type JsonObject } from "@sweatpants/foundation";
import type {
  LogLevel,
  NamedSampleResult,
  SampleRequest,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleSchemaConfig,
  SampleSchemaResult,
  SampleToolsResult,
  ToolMessage,
  ToolSamplingMessage,
  ToolSampleConfig,
} from "@sweatpants/agent-sdk/tool";
import type { Operation } from "effection";
import type { WorkerTool, WorkerToolContext } from "./worker-types.ts";

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

  function canonicalSample(
    config: ToolSampleConfig<ToolSamplingMessage>,
  ): Operation<CanonicalSampleResult>;
  function canonicalSample(request: SampleRequest): Operation<NamedSampleResult>;
  function canonicalSample(key: string, request: SampleRequest): Operation<NamedSampleResult>;
  function canonicalSample(
    keyOrRequest: string | ToolSampleConfig<ToolSamplingMessage> | SampleRequest,
    namedRequest?: SampleRequest,
  ): Operation<CanonicalSampleResult | NamedSampleResult> {
    const named = typeof keyOrRequest === "string";
    const request = named ? namedRequest : keyOrRequest;
    if (!request) {
      throw new Error("named sample requires a request");
    }
    const namedOutput = named ? namedSampleOutput(tool, keyOrRequest) : undefined;
    const config = named
      ? sampleRequestToConfig(request, namedOutput)
      : isToolSampleConfig(request)
        ? request
        : sampleRequestToConfig(request, undefined);
    const automatic = "prompt" in config;

    return {
      *[Symbol.iterator]() {
        const result = yield* worker.sample(config);
        track(result.exchange, automatic);
        if (!named && isToolSampleConfig(request)) {
          return result;
        }
        const namedResult: NamedSampleResult = {
          text: result.text,
          ...(result.model !== undefined ? { model: result.model } : {}),
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          exchange: result.exchange,
          content: result.text,
          ...("parsed" in result ? { parsed: result.parsed } : {}),
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
      const result = yield* worker.sampleTools(config);
      track(result.exchange, "prompt" in config);
      return result;
    },
    *sampleSchema<T>(
      config: SampleSchemaConfig<T, ToolSamplingMessage>,
    ): Operation<SampleSchemaResult<T>> {
      const result = yield* worker.sampleSchema<T>(config);
      track(result.exchange, "prompt" in config);
      return result;
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

function namedSampleOutput(tool: RuntimeTool, key: string): StandardSchemaV1 | undefined {
  const definition = tool.samples[key];
  if (!definition) {
    throw new Error(`Named sample "${key}" is not declared by tool "${tool.name}"`);
  }
  return definition.output;
}

function isToolSampleConfig(
  value: ToolSampleConfig<ToolSamplingMessage> | SampleRequest,
): value is ToolSampleConfig<ToolSamplingMessage> {
  return "prompt" in value || "messages" in value;
}

function sampleRequestToConfig(
  request: SampleRequest,
  output: StandardSchemaV1 | undefined,
): ToolSampleConfig<ToolSamplingMessage> {
  const options = request.options ?? {};
  const history = request.exchanges?.flatMap((exchange) => [...exchange.messages]) ?? [];
  if (request.prompt !== undefined && history.length === 0) {
    return output
      ? { prompt: request.prompt, ...options, schema: output }
      : { prompt: request.prompt, ...options };
  }
  const messages: ToolSamplingMessage[] = [
    ...history,
    ...(request.messages ?? []),
    ...(request.prompt !== undefined
      ? [{ role: "user" as const, content: [{ type: "text" as const, text: request.prompt }] }]
      : []),
  ];
  if (messages.length === 0) {
    throw new Error("sample request requires prompt, messages, or exchanges");
  }
  return output ? { messages, ...options, schema: output } : { messages, ...options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
