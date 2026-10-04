import { stableTupleHash } from "@sweatpants/foundation";
import { type Operation, type Subscription } from "effection";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type * as PiAi from "@earendil-works/pi-ai";
import type {
  Model,
  ModelResponse,
  ModelStreamEvent,
  Runtime,
  StreamOptions,
} from "@sweatpants/model-provider";
import { createPiAiRuntime } from "./runtime/pi-ai.ts";
import { FileCredentialStore } from "./auth.ts";
import { isProviderRecord } from "./runtime/schema-normalization.ts";
import {
  installModelProvider,
  ModelProviderModelContext,
  ModelProviderStreamOptionsContext,
  type ModelProviderDriver,
} from "@sweatpants/model-provider";

export * from "./auth.ts";

export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ResolveModelSelectionInput {
  requestModel?: ModelSelection | undefined;
  defaultModel?: ModelSelection | undefined;
  allowedModels?: ModelSelection[] | undefined;
  unsafeAllowAny?: boolean | undefined;
}

export class ModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

export class ModelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyError";
  }
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export function modelSelectionKey(selection: ModelSelection): string {
  return stableTupleHash([selection.provider, selection.id]);
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 200);
}

function parseModelSelectionFields(value: unknown, label: string): ModelSelection {
  if (!isProviderRecord(value)) {
    throw new ModelSelectionError(`${label} must be an object with provider and id fields`);
  }

  const provider = value["provider"];
  const id = value["id"];
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw new ModelSelectionError(`${label}.provider must be a non-empty string`);
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ModelSelectionError(`${label}.id must be a non-empty string`);
  }

  return { provider: provider.trim(), id: id.trim() };
}

export function parseModelSelection(value: unknown, label = "model"): ModelSelection {
  return parseModelSelectionFields(value, label);
}

export function parseRequestModelSelection(
  value: unknown,
  label = "model",
): ModelSelection | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const selection = parseModelSelectionFields(value, label);
  const keys = Object.keys(value as Record<string, unknown>);
  const extras = keys.filter((key) => key !== "provider" && key !== "id");
  if (extras.length > 0) {
    throw new ModelSelectionError(
      `${label} may only contain provider and id fields; unexpected fields: ${extras.join(", ")}`,
    );
  }
  return selection;
}

export function parseAllowedModelsJson(value: string | undefined): ModelSelection[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ModelSelectionError(
      `ALLOWED_CHAT_MODELS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ModelSelectionError(
      "ALLOWED_CHAT_MODELS_JSON must be a JSON array of model selections",
    );
  }

  return parsed.map((entry, index) =>
    parseModelSelection(entry, `ALLOWED_CHAT_MODELS_JSON[${index}]`),
  );
}

function selectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.id === b.id;
}

export function resolveModelSelection(input: ResolveModelSelectionInput): ModelSelection {
  const defaultModel =
    input.defaultModel === undefined
      ? undefined
      : parseModelSelection(input.defaultModel, "defaultModel");
  const selected =
    input.requestModel === undefined
      ? defaultModel
      : parseModelSelection(input.requestModel, "requestModel");

  if (!selected) {
    throw new ModelSelectionError(
      "No chat model selected; configure DEFAULT_CHAT_MODEL_PROVIDER and DEFAULT_CHAT_MODEL_ID or send model.provider/model.id",
    );
  }

  if (input.unsafeAllowAny === true) {
    return selected;
  }

  const allowedModels =
    input.allowedModels === undefined
      ? defaultModel
        ? [defaultModel]
        : []
      : input.allowedModels.map((entry, index) =>
          parseModelSelection(entry, `allowedModels[${index}]`),
        );

  if (allowedModels.length === 0) {
    throw new ModelPolicyError(
      `No allowed chat models are configured; selected ${modelSelectionKey(selected)} is not allowed`,
    );
  }

  if (!allowedModels.some((allowed) => selectionsEqual(allowed, selected))) {
    throw new ModelPolicyError(
      `Chat model ${modelSelectionKey(selected)} is not allowed by server policy`,
    );
  }

  return selected;
}

function fromPiThinkingLevelMap(
  value: PiAi.ThinkingLevelMap | undefined,
): Model["thinkingLevelMap"] | undefined {
  if (value === undefined) return undefined;
  const { max, ...shared } = value;
  return {
    ...shared,
    ...(max === undefined ? {} : { xhigh: max }),
  };
}

function fromPiAiModel(model: PiAi.Model<string>): Model {
  const thinkingLevelMap = fromPiThinkingLevelMap(model.thinkingLevelMap);
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
    reasoning: model.reasoning,
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
    ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}),
    metadata: { source: "pi-ai-registry" },
  };
}

export function redactSensitiveString(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA[redacted]")
    .replace(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, "[redacted-secret]")
    .replace(/arn:aws:[^\s"']+/g, "[redacted-aws-arn]")
    .replace(/\b\d{12}\b/g, "[redacted-account-id]")
    .slice(0, 2000);
}

function createPiAiModelProviderDriver(runtime: Runtime): ModelProviderDriver {
  return {
    *stream(request) {
      return runtime.stream(request.model, request.context, request.options);
    },
    *sample(request): Operation<ModelResponse> {
      const hasTools = request.context.tools.length > 0;
      const subscription: Subscription<ModelStreamEvent, ModelResponse> = yield* runtime.stream(
        request.model,
        request.context,
        {
          ...request.options,
          ...(request.options?.toolChoice !== undefined
            ? { toolChoice: request.options.toolChoice }
            : hasTools
              ? { toolChoice: "none" as const }
              : {}),
        },
      );
      while (true) {
        const next = yield* subscription.next();
        if (next.done) {
          return next.value;
        }
      }
    },
  };
}

export interface CreatePiAiModelProviderOptions {
  /** One collection owns model resolution, credentials, and provider execution. */
  readonly models?: PiAi.Models;
}

export interface InstallPiAiModelProviderOptions {
  model?: Model;
  streamOptions?: StreamOptions;
}

export interface ConfiguredModelProvider {
  readonly runtime: Runtime;
  readonly driver: ModelProviderDriver;
  resolveModel(selection: ModelSelection): Model;
  install(options?: InstallPiAiModelProviderOptions): Operation<void>;
}

export function createPiAiModelProvider(
  options: CreatePiAiModelProviderOptions = {},
): ConfiguredModelProvider {
  const models = options.models ?? builtinModels({ credentials: new FileCredentialStore() });
  const runtime = createPiAiRuntime({ models });
  const driver = createPiAiModelProviderDriver(runtime);
  return {
    runtime,
    driver,
    resolveModel(selection) {
      const normalized = parseModelSelection(selection, "model");
      const model = models.getModel(normalized.provider, normalized.id);
      if (model) return fromPiAiModel(model);
      throw new ModelResolutionError(
        `Unable to resolve chat model ${sanitizeIdentifier(normalized.provider)}/${sanitizeIdentifier(normalized.id)}`,
      );
    },
    *install(installation = {}) {
      yield* installModelProvider(driver);
      if (installation.model) {
        yield* ModelProviderModelContext.set(installation.model);
      }
      if (installation.streamOptions) {
        yield* ModelProviderStreamOptionsContext.set(installation.streamOptions);
      }
    },
  };
}
