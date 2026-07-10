import type { Operation } from "effection";
import type { z, ZodSchema } from "zod";

// =============================================================================
// Canonical core tool substrate
// =============================================================================

export type LogLevel = "debug" | "info" | "warning" | "error";
export type InferSchema<T> = T extends ZodSchema<infer O> ? O : unknown;
export type AnySchema<T = unknown> = ZodSchema<T>;

export interface PerCallInterruptOptions {
  reason?: string;
  expiresAt?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Message data types (plain data; no runtime deps)
// -----------------------------------------------------------------------------

export type ToolRole = "user" | "assistant";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: ToolContentBlock[];
}

export type ToolContentBlock = ToolTextContent | ToolUseContent | ToolResultContent;

export interface ToolMessage {
  role: ToolRole;
  content: ToolContentBlock | ToolContentBlock[];
}

// -----------------------------------------------------------------------------
// Elicit definitions (response-first)
// -----------------------------------------------------------------------------

/**
 * Definition of an elicit request/response pair with optional context.
 *
 * Type parameters are **response-first** (required before optional).
 */
export interface ElicitDefinition<TResponseSchema = ZodSchema, TContextSchema = undefined> {
  readonly description?: string;
  readonly response: TResponseSchema;
  readonly context?: TContextSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ElicitEntry<TResponseSchema = ZodSchema, TContextSchema = undefined> =
  | TResponseSchema
  | ElicitDefinition<TResponseSchema, TContextSchema>;

export type ElicitsMap = Record<string, ElicitEntry<any, any>>;

export type ExtractElicitResponse<E> =
  E extends ElicitDefinition<infer R, any> ? InferSchema<R> : InferSchema<E>;

export type ExtractElicitContext<E> = E extends { readonly context: infer C }
  ? InferSchema<C>
  : undefined;

export type ExtractElicitResponseSchema<E> = E extends ElicitDefinition<infer R, any> ? R : E;

export type ExtractElicitContextSchema<E> = E extends { readonly context: infer C } ? C : undefined;

export type NormalizedElicitDefinition<TResponse = unknown, TContext = unknown> = ElicitDefinition<
  ZodSchema<TResponse>,
  ZodSchema<TContext> | undefined
>;

export type NormalizedElicitsMap<TElicits extends ElicitsMap = ElicitsMap> = {
  readonly [K in keyof TElicits]: NormalizedElicitDefinition<
    ExtractElicitResponse<TElicits[K]>,
    ExtractElicitContext<TElicits[K]>
  >;
};

// -----------------------------------------------------------------------------
// Sample definitions
// -----------------------------------------------------------------------------

export interface SampleDefinition<TOutputSchema = undefined> {
  readonly description?: string;
  readonly output?: TOutputSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SamplesMap = Record<string, SampleDefinition<any>>;
export type NormalizedSamplesMap<TSamples extends SamplesMap = SamplesMap> = {
  readonly [K in keyof TSamples]: SampleDefinition<
    TSamples[K] extends SampleDefinition<infer O> ? O : undefined
  >;
};

// -----------------------------------------------------------------------------
// Exchange types (message-pair shape — what runtimes construct)
// -----------------------------------------------------------------------------

/**
 * Elicitation exchange — request/response message pair for sampling history.
 */
export interface ElicitExchange<TContext> {
  context: TContext;
  request: ToolMessage & { role: "assistant" };
  response: ToolMessage & { role: "user" };
  messages: [ToolMessage, ToolMessage];
  withArguments(fn: (context: TContext) => Record<string, unknown>): [ToolMessage, ToolMessage];
}

/**
 * Sampling exchange — messages for history accumulation.
 * Raw sampling: 2 messages; structured output: 3 messages (tool_use + tool_result).
 */
export interface SampleExchange<TParsed = undefined> {
  /** The request message sent to the model (user, text content). */
  request: ToolMessage & { role: "user" };
  /** The assistant's response (text, or tool_use for structured output). */
  response: ToolMessage & { role: "assistant" };
  /** All messages for history accumulation (2 raw / 3 structured). */
  messages: ToolMessage[];
  /** Parsed structured data — present only on structured-output exchanges. */
  parsed?: TParsed;
}

// -----------------------------------------------------------------------------
// Result types
// -----------------------------------------------------------------------------

/**
 * What `ctx.elicit` returns to tool code. Exchange present only on accept.
 */
export type ToolElicitResult<TContext, TResponse> =
  | { action: "accept"; content: TResponse; exchange: ElicitExchange<TContext> }
  | { action: "decline"; reason?: string }
  | { action: "cancel"; reason?: string };

/**
 * Transport payload for elicit responses (no exchange).
 */
export type WireElicitResult<TResponse = unknown> =
  | { action: "accept"; content: TResponse }
  | { action: "decline"; reason?: string }
  | { action: "cancel"; reason?: string };

// -----------------------------------------------------------------------------
// Sample request / result (tool-side)
// -----------------------------------------------------------------------------

export interface SampleRequest {
  readonly prompt?: string;
  readonly messages?: readonly unknown[];
  readonly exchanges?: readonly (ElicitExchange<unknown> | SampleExchange)[];
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface SampleResultBase {
  readonly text: string;
  readonly model?: string;
  readonly stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
  readonly exchange: SampleExchange<undefined>;
}

export interface SampleResultWithParsed<T> {
  readonly text: string;
  readonly model?: string;
  readonly stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
  readonly parsed: T | null;
  readonly parseError?: { message: string; rawText: string };
  readonly exchange: SampleExchange<T | null>;
}

export interface SamplingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface SampleResultWithToolCalls {
  readonly text: string;
  readonly model?: string;
  readonly stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
  readonly toolCalls: SamplingToolCall[];
  readonly exchange: SampleExchange<undefined>;
}

/** @deprecated Prefer SampleResultBase / SampleResultWithParsed */
export type SampleResult<TParsed = unknown> = SampleResultBase & {
  readonly content?: string;
  readonly parsed?: TParsed;
  readonly raw?: unknown;
};

export interface WireSampleResultBase {
  text: string;
  model?: string;
  stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
}

export interface WireSampleResultWithParsed<T> extends WireSampleResultBase {
  parsed: T | null;
  parseError?: { message: string; rawText: string };
}

export interface WireSampleResultWithToolCalls extends WireSampleResultBase {
  toolCalls: SamplingToolCall[];
}

export type WireSampleResult =
  | WireSampleResultBase
  | WireSampleResultWithParsed<unknown>
  | WireSampleResultWithToolCalls;

// -----------------------------------------------------------------------------
// Sample config types (for ToolCtx overloads)
// -----------------------------------------------------------------------------

export interface ModelPreferences {
  hints?: Array<{ name: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface SamplingToolDefinition {
  name: string;
  description?: string;
  inputSchema: ZodSchema | Record<string, unknown>;
}

export type SamplingToolChoice = "auto" | "required" | "none";

interface SampleConfigBase {
  systemPrompt?: string;
  maxTokens?: number;
  modelPreferences?: ModelPreferences;
}

interface SampleConfigPlain extends SampleConfigBase {
  schema?: never;
  tools?: never;
  toolChoice?: never;
}

interface SampleConfigWithSchema<T = unknown> extends SampleConfigBase {
  schema: ZodSchema<T>;
  tools?: never;
  toolChoice?: never;
}

interface SampleConfigWithTools extends SampleConfigBase {
  tools: SamplingToolDefinition[];
  toolChoice?: SamplingToolChoice;
  schema?: never;
}

interface SampleConfigPromptMode {
  prompt: string;
  messages?: never;
}

interface SampleConfigMessagesMode {
  messages: readonly unknown[];
  prompt?: never;
}

export type SampleConfigPlainPrompt = SampleConfigPlain & SampleConfigPromptMode;
export type SampleConfigPlainMessages = SampleConfigPlain & SampleConfigMessagesMode;
export type SampleConfigSchemaPrompt<T = unknown> = SampleConfigWithSchema<T> &
  SampleConfigPromptMode;
export type SampleConfigSchemaMessages<T = unknown> = SampleConfigWithSchema<T> &
  SampleConfigMessagesMode;
export type SampleConfigToolsPrompt = SampleConfigWithTools & SampleConfigPromptMode;
export type SampleConfigToolsMessages = SampleConfigWithTools & SampleConfigMessagesMode;

export type ToolSampleConfig =
  | SampleConfigPlainPrompt
  | SampleConfigPlainMessages
  | SampleConfigSchemaPrompt
  | SampleConfigSchemaMessages
  | SampleConfigToolsPrompt
  | SampleConfigToolsMessages;

export interface SampleToolsConfigBase extends SampleConfigBase {
  tools: SamplingToolDefinition[];
  toolChoice?: SamplingToolChoice;
  retries?: number;
}

export type SampleToolsConfig = SampleToolsConfigBase & SampleConfigPromptMode;
export type SampleToolsConfigMessages = SampleToolsConfigBase & SampleConfigMessagesMode;

export interface SampleToolsResult {
  text: string;
  model?: string;
  stopReason?: string;
  toolCalls: SamplingToolCall[];
  exchange: SampleExchange<undefined>;
}

export interface SampleSchemaConfigBase<T> extends SampleConfigBase {
  schema: ZodSchema<T>;
  retries?: number;
}

export type SampleSchemaConfig<T> = SampleSchemaConfigBase<T> & SampleConfigPromptMode;
export type SampleSchemaConfigMessages<T> = SampleSchemaConfigBase<T> & SampleConfigMessagesMode;

export interface SampleSchemaResult<T> {
  text: string;
  model?: string;
  stopReason?: string;
  parsed: T;
  exchange: SampleExchange<T>;
}

// -----------------------------------------------------------------------------
// ToolCtx — complete tool-facing contract (no index signature)
// -----------------------------------------------------------------------------

export interface BaseToolCtx {
  /** Conversation messages visible to the current tool invocation. */
  readonly messages: readonly ToolMessage[];
  notify(message: string, progress?: number, level?: LogLevel): Operation<void>;
  log(level: LogLevel, message: string): Operation<void>;
}

type ElicitRequestFor<E> =
  ExtractElicitContext<E> extends undefined
    ? { message: string; interrupt?: PerCallInterruptOptions }
    : { message: string; context: ExtractElicitContext<E>; interrupt?: PerCallInterruptOptions };

export interface ToolElicitCtx<TElicits extends ElicitsMap> {
  elicit<K extends keyof TElicits & string>(
    key: K,
    request: ElicitRequestFor<TElicits[K]>,
  ): Operation<
    ToolElicitResult<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>
  >;
}

export interface ToolGenericSampleCtx {
  sample(config: SampleConfigPlainPrompt | SampleConfigPlainMessages): Operation<SampleResultBase>;
  sample<T>(
    config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T>,
  ): Operation<SampleResultWithParsed<T>>;
  sample(
    config: SampleConfigToolsPrompt | SampleConfigToolsMessages,
  ): Operation<SampleResultWithToolCalls>;
  sample(
    config: ToolSampleConfig,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>;
  sampleSchema<T>(
    config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>,
  ): Operation<SampleSchemaResult<T>>;
  /** Keyed sample request form used by some tools / tests */
  sample(request: SampleRequest): Operation<SampleResult>;
}

type SampleParsed<TSamples extends SamplesMap, K extends keyof TSamples> =
  TSamples[K] extends SampleDefinition<infer TOutputSchema>
    ? TOutputSchema extends undefined
      ? unknown
      : InferSchema<TOutputSchema>
    : unknown;

export interface ToolNamedSampleCtx<TSamples extends SamplesMap> {
  sample(config: SampleConfigPlainPrompt | SampleConfigPlainMessages): Operation<SampleResultBase>;
  sample<T>(
    config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T>,
  ): Operation<SampleResultWithParsed<T>>;
  sample(
    config: SampleConfigToolsPrompt | SampleConfigToolsMessages,
  ): Operation<SampleResultWithToolCalls>;
  sample(
    config: ToolSampleConfig,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;
  sample(request: SampleRequest): Operation<SampleResult>;
  sample<K extends keyof TSamples & string>(
    key: K,
    request: SampleRequest,
  ): Operation<SampleResult<SampleParsed<TSamples, K>>>;
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>;
  sampleSchema<T>(
    config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>,
  ): Operation<SampleSchemaResult<T>>;
}

/** Detects the `any` type (used so RuntimeTool stays a universal sink). */
type IsAny<T> = 0 extends 1 & T ? true : false;

type ElicitCtxIfDeclared<TElicits> =
  IsAny<TElicits> extends true
    ? ToolElicitCtx<any>
    : TElicits extends ElicitsMap
      ? keyof TElicits extends never
        ? {}
        : ToolElicitCtx<TElicits>
      : {};

type SampleCtxIfDeclared<TSamples> =
  IsAny<TSamples> extends true
    ? ToolNamedSampleCtx<any>
    : TSamples extends true
      ? ToolGenericSampleCtx
      : TSamples extends SamplesMap
        ? ToolNamedSampleCtx<TSamples>
        : {};

export type ToolCtx<TElicits = undefined, TSamples = undefined> = BaseToolCtx &
  ElicitCtxIfDeclared<TElicits> &
  SampleCtxIfDeclared<TSamples>;

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export interface ToolExtensionMetadata {
  readonly namespace?: string;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

export interface ToolExtension<
  TState = unknown,
  TMetadata extends ToolExtensionMetadata = ToolExtensionMetadata,
> {
  readonly namespace?: string;
  readonly metadata?: TMetadata;
  apply?(state: TState): TState | void;
}

export interface ToolDefinition<
  TName extends string = string,
  TParams = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = {},
  TSamples extends SamplesMap | true | undefined = undefined,
> {
  (ctx: ToolCtx<TElicits, TSamples>): Operation<(input: TParams) => Operation<TResult>>;
  readonly name: TName;
  readonly description: string;
  readonly parameters: ZodSchema<TParams>;
  readonly output?: ZodSchema<TResult>;
  readonly elicits: NormalizedElicitsMap<TElicits>;
  readonly samples: TSamples extends SamplesMap
    ? NormalizedSamplesMap<TSamples>
    : Readonly<Record<string, never>>;
  readonly schemas: { readonly input: ZodSchema<TParams>; readonly output?: ZodSchema<TResult> };
  readonly capabilities: { readonly elicitation: boolean; readonly sampling: boolean };
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly extensions: readonly ToolExtensionMetadata[];
}

/** Wire-boundary erased tool type — deliberately `any`-parameterized. */
export type RuntimeTool = ToolDefinition<string, any, any, any, any>;

export interface CreateToolBuilderBase<TName extends string> {
  description(desc: string): CreateToolBuilderWithDescription<TName>;
}

export interface CreateToolBuilderWithDescription<TName extends string> {
  parameters<TSchema extends ZodSchema>(
    schema: TSchema,
  ): CreateToolBuilderWithParams<TName, z.infer<TSchema>, undefined, undefined, undefined>;
}

export interface CreateToolBuilderWithParams<
  TName extends string,
  TInput,
  TOutput = undefined,
  TElicits extends ElicitsMap | undefined = undefined,
  TSamples extends SamplesMap | true | undefined = undefined,
> {
  output<TSchema extends ZodSchema>(
    schema: TSchema,
  ): CreateToolBuilderWithParams<TName, TInput, z.infer<TSchema>, TElicits, TSamples>;
  elicits<TNextElicits extends ElicitsMap>(
    elicits: TNextElicits,
  ): CreateToolBuilderWithParams<TName, TInput, TOutput, TNextElicits, TSamples>;
  samples(): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, true>;
  samples<TNextSamples extends SamplesMap>(
    samples: TNextSamples,
  ): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TNextSamples>;
  use(
    extension: ToolExtension<
      CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>
    >,
  ): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>;
  annotate(
    namespace: string,
    value: unknown,
  ): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>;
  requires(caps: {
    elicitation?: boolean;
    sampling?: boolean;
  }): CreateToolBuilderWithParams<TName, TInput, TOutput, TElicits, TSamples>;
  execute<TResult extends TOutput extends undefined ? unknown : TOutput>(
    fn: (input: TInput, ctx: ToolCtx<TElicits, TSamples>) => Operation<TResult>,
  ): ToolDefinition<
    TName,
    TInput,
    TOutput extends undefined ? TResult : TOutput,
    TElicits extends ElicitsMap ? TElicits : {},
    TSamples
  >;
}

/** Compatibility alias for older type names. */
export type CreateToolBuilderWithElicits<
  TName extends string,
  TInput,
  TElicits extends ElicitsMap,
> = CreateToolBuilderWithParams<TName, TInput, undefined, TElicits, undefined>;
