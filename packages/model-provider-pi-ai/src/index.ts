import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { type Operation, type Subscription } from "effection";
import {
  getModel as getPiAiRegistryModel,
  type Model as PiAiRegistryModel,
} from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  Model,
  Runtime,
  StreamEvent,
  StreamOptions,
} from "./runtime/index.ts";
import { createOllamaModel, createOpenAiResponsesModel, piAiRuntime } from "./runtime/index.ts";
import {
  ModelProviderContext,
  ModelProviderModelContext,
  ModelProviderStreamOptionsContext,
  type ModelProviderDriver,
} from "@sweatpants/framework/chat";

export * from "./runtime/index.ts";

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

export function normalizeOllamaBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function modelSelectionKey(selection: ModelSelection): string {
  return `${selection.provider}/${selection.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 200);
}

function validateModelSelectionFields(value: unknown, label: string): ModelSelection {
  if (!isRecord(value)) {
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
  return validateModelSelectionFields(value, label);
}

export function parseRequestModelSelection(
  value: unknown,
  label = "model",
): ModelSelection | undefined {
  if (value === undefined || value === null) return undefined;
  const selection = validateModelSelectionFields(value, label);
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
  if (value === undefined || value.trim().length === 0) return undefined;

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

function fromPiAiModel(model: PiAiRegistryModel<string>): Model {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
    ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}),
    metadata: { source: "pi-ai-registry" },
  };
}

function registryLookup(selection: ModelSelection): Model | undefined {
  const lookup = getPiAiRegistryModel as unknown as (
    provider: string,
    modelId: string,
  ) => PiAiRegistryModel<string> | undefined;
  const model = lookup(selection.provider, selection.id);
  return model ? fromPiAiModel(model) : undefined;
}

export function resolvePiAiModel(selection: ModelSelection): Model {
  const normalized = parseModelSelection(selection, "model");
  const registryModel = registryLookup(normalized);
  if (registryModel) return withGitHubCopilotAuth(registryModel);

  if (normalized.provider === "ollama") {
    return createOllamaModel(
      normalized.id,
      normalizeOllamaBaseUrl(
        process.env["OLLAMA_BASE_URL"] ?? process.env["OLLAMA_URL"] ?? "http://localhost:11434",
      ),
    );
  }

  if (normalized.provider === "openai") {
    return createOpenAiResponsesModel(
      normalized.id,
      (process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").trim(),
    );
  }

  throw new ModelResolutionError(
    `Unable to resolve chat model ${sanitizeIdentifier(normalized.provider)}/${sanitizeIdentifier(normalized.id)}`,
  );
}

function withGitHubCopilotAuth(model: Model): Model {
  if (model.provider !== "github-copilot") return model;

  const token =
    process.env["COPILOT_GITHUB_TOKEN"] ?? readGitHubCopilotAccessTokenFromSweatpantsAuth();
  if (!token) return model;

  const baseUrl = githubCopilotBaseUrlFromAccessToken(token);
  if (!process.env["COPILOT_GITHUB_TOKEN"]) {
    process.env["COPILOT_GITHUB_TOKEN"] = token;
  }
  return baseUrl ? { ...model, baseUrl } : model;
}

function readGitHubCopilotAccessTokenFromSweatpantsAuth(): string | undefined {
  return readGitHubCopilotAccessTokenFromAuthFile(
    process.env["SWEATPANTS_AUTH_FILE"] ?? `${homedir()}/.sweatpants/auth.json`,
  );
}

function readGitHubCopilotAccessTokenFromAuthFile(authPath: string): string | undefined {
  if (!existsSync(authPath)) return undefined;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
      ["github-copilot"]?: { access?: unknown; type?: unknown };
    };
    const access = auth["github-copilot"]?.access;
    return typeof access === "string" && access.trim().length > 0 ? access : undefined;
  } catch {
    return undefined;
  }
}

function githubCopilotBaseUrlFromAccessToken(token: string): string | undefined {
  const match = token.match(/proxy-ep=([^;]+)/);
  const proxyHost = match?.[1];
  if (!proxyHost) return undefined;
  return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
}

export function redactSensitiveString(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA[redacted]")
    .replace(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, "[redacted-secret]")
    .replace(/arn:aws:[^\s"']+/g, "[redacted-aws-arn]")
    .replace(/\b\d{12}\b/g, "[redacted-account-id]")
    .slice(0, 2000);
}

export function createPiAiModelProviderDriver(runtime: Runtime = piAiRuntime): ModelProviderDriver {
  return {
    stream(request) {
      return runtime.stream(request.model, request.context, request.options);
    },
    *sample(request): Operation<AssistantMessage> {
      const hasTools = (request.context.tools?.length ?? 0) > 0;
      const subscription: Subscription<StreamEvent, AssistantMessage> = yield* runtime.stream(
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
        if (next.done) return next.value;
      }
    },
  };
}

export interface InstallPiAiModelProviderOptions {
  driver?: ModelProviderDriver;
  model?: Model;
  streamOptions?: StreamOptions;
}

export function* installPiAiModelProvider(
  options: InstallPiAiModelProviderOptions = {},
): Operation<void> {
  yield* ModelProviderContext.set(options.driver ?? createPiAiModelProviderDriver());
  if (options.model) {
    yield* ModelProviderModelContext.set(options.model);
  }
  if (options.streamOptions) {
    yield* ModelProviderStreamOptionsContext.set(options.streamOptions);
  }
}
