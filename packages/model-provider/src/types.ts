import type { Operation, Stream } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import type { ChatContent } from "@sweatpants/chat-contract";
import type { ModelContext, ModelResponse, ModelStreamEvent, ModelUsage } from "./model.ts";

export interface Runtime {
  stream(
    model: Model,
    context: ModelContext,
    options?: StreamOptions,
  ): Stream<ModelStreamEvent, ModelResponse>;
  generateImages(
    model: ImageModel,
    context: ImageGenerationContext,
    options?: ImageGenerationOptions,
  ): Operation<AssistantImages>;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingSetting = "off" | ThinkingLevel;
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: InputModality[];
  contextWindow: number;
  maxTokens: number;
  cost?: Cost;
  compat?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ImageModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  input: InputModality[];
  output: OutputModality[];
  cost?: Cost;
  compat?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type InputModality = "text" | "image" | "audio";
export type OutputModality = "text" | "image";

export interface ImageGenerationContext {
  readonly input: ChatContent;
}

export interface AssistantImages {
  readonly output: ChatContent;
  readonly usage: ModelUsage | null;
  readonly stopReason: string | null;
  readonly responseId: string | null;
  readonly errorMessage: string | null;
  readonly metadata: JsonObject;
}

export interface StreamOptions {
  signal?: AbortSignal;
  apiKey?: string | null;
  env?: Record<string, string | undefined>;
  sessionId?: string;
  toolChoice?: "auto" | "none" | "required";
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  /** User-facing thinking setting. `off` is normalized to no provider reasoning request. */
  thinking?: ThinkingSetting;
  thinkingBudgets?: ThinkingBudgets;
  responseFormat?: { type: "json_schema"; name?: string; schema: JsonObject };
  providerOptions?: Record<string, unknown>;
  onPayload?: (payload: unknown) => void;
}

export interface ImageGenerationOptions {
  signal?: AbortSignal;
  apiKey?: string | null;
  env?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  onPayload?: (payload: unknown) => void;
  onResponse?: (response: unknown) => void;
}

export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
