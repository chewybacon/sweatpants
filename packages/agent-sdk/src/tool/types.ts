import type { DocumentSlots, ElicitDocumentSlots } from "./documents.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { SchemaBinding, PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { ToolInteractionBindings } from "./interaction-binding.ts";
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolCall,
  ChatToolResultMessage,
  ChatUserMessage,
} from "@sweatpants/chat-contract";

/** Portable descriptors for one declared elicitation (content-schema semantics). */
export interface SchemaProjectionOptions {
  readonly inputProjection?: Json;
  readonly outputProjection?: Json;
}

export interface ToolElicitSchemaArtifact {
  /** Accepted-content descriptor; never the outer wire action envelope. */
  readonly response: PortableSchemaDescriptor;
  readonly context?: PortableSchemaDescriptor;
  readonly documents?: Readonly<Record<string, PortableSchemaDescriptor>>;
}

/**
 * Retained portable schema projections plus the digest-keyed runtime
 * validator catalog for one tool. Consumers (inventory, providers, browser
 * forms) use the projections without re-lowering the runtime schema;
 * authorities merge `catalog` entries into scope-local registries.
 */
export interface ToolSchemaArtifacts {
  readonly parameters: PortableSchemaDescriptor;
  readonly output?: PortableSchemaDescriptor;
  readonly elicits: Readonly<Record<string, ToolElicitSchemaArtifact>>;
  /** Runtime validators; never persisted or transported. */
  readonly catalog: readonly SchemaBinding[];
}

// =============================================================================
// Canonical core tool substrate
// =============================================================================

export type LogLevel = "debug" | "info" | "warning" | "error";
/** Validated (output) type of a Standard Schema; Zod schemas satisfy this. */
export type InferSchema<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : unknown;
/** Pre-validation (input) type of a Standard Schema; producers use this side. */
export type InferSchemaInput<T> = T extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<T>
  : unknown;
export type AnySchema<T = unknown> = StandardSchemaV1<unknown, T>;

export interface PerCallInterruptOptions {
  reason?: string;
  expiresAt?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Message values are canonical Chat contracts. Protocol-owned worker/MCP
// messages are decoded at their adapters before reaching authored sampling.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Elicit definitions (response-first)
// -----------------------------------------------------------------------------

/**
 * Definition of an elicit request/response pair with optional context.
 *
 * Type parameters are **response-first** (required before optional).
 */
export interface ElicitDefinition<
  TResponseSchema extends StandardSchemaV1 = StandardSchemaV1,
  TContextSchema extends StandardSchemaV1 | undefined = undefined,
> {
  readonly description?: string;
  readonly response: TResponseSchema;
  readonly context?: TContextSchema;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Explicit projections required for non-Zod durable schemas. */
  readonly responseProjections?: SchemaProjectionOptions;
  readonly contextProjections?: SchemaProjectionOptions;
  readonly documents?: DocumentSlots;
}

export type ElicitEntry<
  TResponseSchema extends StandardSchemaV1 = StandardSchemaV1,
  TContextSchema extends StandardSchemaV1 | undefined = undefined,
> = TResponseSchema | ElicitDefinition<TResponseSchema, TContextSchema>;

export type ElicitsMap = Record<string, ElicitEntry<any, any>>;

export type ExtractElicitResponse<E> =
  E extends ElicitDefinition<infer R, any> ? InferSchema<R> : InferSchema<E>;

/** Pre-validation content type produced by plugin handlers (Standard Schema input side). */
export type ExtractElicitResponseInput<E> =
  E extends ElicitDefinition<infer R, any> ? InferSchemaInput<R> : InferSchemaInput<E>;

type ExtractElicitContextSchemaValue<E> = E extends { readonly context?: infer C }
  ? Exclude<C, undefined>
  : never;

/** Validated (Standard Schema output) value supplied to a client handler. */
export type ExtractElicitContext<E> = [ExtractElicitContextSchemaValue<E>] extends [never]
  ? undefined
  : ExtractElicitContextSchemaValue<E> extends StandardSchemaV1
    ? InferSchema<ExtractElicitContextSchemaValue<E>>
    : undefined;

/** Authored (Standard Schema input) value supplied by a tool producer. */
export type ExtractElicitContextInput<E> = [ExtractElicitContextSchemaValue<E>] extends [never]
  ? undefined
  : ExtractElicitContextSchemaValue<E> extends StandardSchemaV1
    ? InferSchemaInput<ExtractElicitContextSchemaValue<E>>
    : undefined;

export type ExtractElicitResponseSchema<E> = E extends ElicitDefinition<infer R, any> ? R : E;

export type ExtractElicitContextSchema<E> = ExtractElicitContextSchemaValue<E>;

export type NormalizedElicitDefinition<
  TResponse = unknown,
  TContext = unknown,
  TResponseInput = TResponse,
  TContextInput = TContext,
> = ElicitDefinition<
  StandardSchemaV1<TResponseInput, TResponse>,
  StandardSchemaV1<TContextInput, TContext> | undefined
>;

export type NormalizedElicitsMap<TElicits extends ElicitsMap = ElicitsMap> = {
  readonly [K in keyof TElicits]: NormalizedElicitDefinition<
    ExtractElicitResponse<TElicits[K]>,
    ExtractElicitContext<TElicits[K]>,
    ExtractElicitResponseInput<TElicits[K]>,
    ExtractElicitContextInput<TElicits[K]>
  > &
    (TElicits[K] extends { readonly documents: DocumentSlots }
      ? { readonly documents: ElicitDocumentSlots<TElicits[K]> }
      : {});
};

// -----------------------------------------------------------------------------
// Sample definitions
// -----------------------------------------------------------------------------

export interface SampleDefinition<TOutputSchema extends StandardSchemaV1 | undefined = undefined> {
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
  request: ChatAssistantMessage;
  response: ChatToolResultMessage;
  messages: [ChatAssistantMessage, ChatToolResultMessage];
  withArguments(fn: (context: TContext) => Json): [ChatAssistantMessage, ChatToolResultMessage];
}

/**
 * Sampling exchange — messages for history accumulation.
 * Raw sampling: 2 messages; structured output: 3 messages (tool_use + tool_result).
 */
export interface SampleExchange<TParsed = undefined> {
  /** The request message sent to the model (user, text content). */
  request: ChatUserMessage;
  /** The assistant's response (text, or a tool call for structured output). */
  response: ChatAssistantMessage;
  /** All messages for history accumulation (2 raw / 3 structured). */
  messages: ChatMessage[];
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
export type ElicitExchangeCompletion<TResponse = unknown> =
  | { action: "accept"; content: TResponse }
  | { action: "decline"; reason?: string }
  | { action: "cancel"; reason?: string };

// -----------------------------------------------------------------------------
// Sample request / result (tool-side)
// -----------------------------------------------------------------------------

export interface SampleRequestOptions {
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly modelPreferences?: ModelPreferences;
}

export interface SampleRequest {
  readonly prompt?: string;
  readonly messages?: readonly ChatMessage[];
  readonly exchanges?: readonly (ElicitExchange<unknown> | SampleExchange)[];
  readonly options?: SampleRequestOptions;
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

export interface SampleResultWithToolCalls {
  readonly text: string;
  readonly model?: string;
  readonly stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
  readonly toolCalls: ChatToolCall[];
  readonly exchange: SampleExchange<undefined>;
}

export interface NamedSampleResult<TParsed = unknown> {
  readonly text: string;
  readonly model?: string;
  readonly stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
  readonly exchange: SampleExchange<unknown>;
  readonly content?: string;
  readonly parsed?: TParsed | null;
  readonly raw?: unknown;
}

export interface SampleExchangeCompletionBase {
  text: string;
  model?: string;
  stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
}

export interface ParsedSampleExchangeCompletion<T> extends SampleExchangeCompletionBase {
  parsed: T | null;
  parseError?: { message: string; rawText: string };
}

export interface ToolCallSampleExchangeCompletion extends SampleExchangeCompletionBase {
  toolCalls: ChatToolCall[];
}

export type SampleExchangeCompletion =
  | SampleExchangeCompletionBase
  | ParsedSampleExchangeCompletion<unknown>
  | ToolCallSampleExchangeCompletion;

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
  inputSchema: StandardSchemaV1 | Record<string, unknown>;
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
  schema: StandardSchemaV1<unknown, T>;
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

interface SampleConfigMessagesMode<TMessage = unknown> {
  messages: readonly TMessage[];
  prompt?: never;
}

export type SampleConfigPlainPrompt = SampleConfigPlain & SampleConfigPromptMode;
export type SampleConfigPlainMessages<TMessage = unknown> = SampleConfigPlain &
  SampleConfigMessagesMode<TMessage>;
export type SampleConfigSchemaPrompt<T = unknown> = SampleConfigWithSchema<T> &
  SampleConfigPromptMode;
export type SampleConfigSchemaMessages<
  T = unknown,
  TMessage = unknown,
> = SampleConfigWithSchema<T> & SampleConfigMessagesMode<TMessage>;
export type SampleConfigToolsPrompt = SampleConfigWithTools & SampleConfigPromptMode;
export type SampleConfigToolsMessages<TMessage = unknown> = SampleConfigWithTools &
  SampleConfigMessagesMode<TMessage>;

/** Authored sampling configuration, parameterized by the owning history carrier. */
export type ToolSampleConfig<TMessage = unknown> =
  | SampleConfigPlainPrompt
  | SampleConfigPlainMessages<TMessage>
  | SampleConfigSchemaPrompt
  | SampleConfigSchemaMessages<unknown, TMessage>
  | SampleConfigToolsPrompt
  | SampleConfigToolsMessages<TMessage>;

export interface SampleToolsConfigBase extends SampleConfigBase {
  tools: SamplingToolDefinition[];
  toolChoice?: SamplingToolChoice;
  retries?: number;
}

export type SampleToolsConfig<TMessage = unknown> = SampleToolsConfigBase &
  (SampleConfigPromptMode | SampleConfigMessagesMode<TMessage>);

/** Successful `sampleTools` result; the helper guarantees at least one call. */
export interface SampleToolsResult {
  text: string;
  model?: string;
  stopReason: "toolUse";
  toolCalls: [ChatToolCall, ...ChatToolCall[]];
  exchange: SampleExchange<undefined>;
}

export interface SampleSchemaConfigBase<T> extends SampleConfigBase {
  schema: StandardSchemaV1<unknown, T>;
  retries?: number;
}

export type SampleSchemaConfig<T, TMessage = unknown> = SampleSchemaConfigBase<T> &
  (SampleConfigPromptMode | SampleConfigMessagesMode<TMessage>);

export interface SampleSchemaResult<T> {
  text: string;
  model?: string;
  stopReason?: string;
  parsed: T;
  exchange: SampleExchange<T>;
}

/** Failure from a sampling helper after its authored retry policy is exhausted. */
export class SampleValidationError extends Error {
  constructor(
    public readonly helperName: "sampleTools" | "sampleSchema",
    public readonly attempts: number,
    public readonly lastResult:
      | SampleResultBase
      | SampleResultWithParsed<unknown>
      | SampleResultWithToolCalls,
    message: string,
  ) {
    super(message);
    this.name = "SampleValidationError";
  }
}

/** Canonical authored sampling surface specialized by a domain message carrier. */
export interface ToolSamplingCtx<TMessage = ChatMessage> {
  sample(
    config: SampleConfigPlainPrompt | SampleConfigPlainMessages<TMessage>,
  ): Operation<SampleResultBase>;
  sample<T>(
    config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T, TMessage>,
  ): Operation<SampleResultWithParsed<T>>;
  sample(
    config: SampleConfigToolsPrompt | SampleConfigToolsMessages<TMessage>,
  ): Operation<SampleResultWithToolCalls>;
  sample(
    config: ToolSampleConfig<TMessage>,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;
  sampleTools(config: SampleToolsConfig<TMessage>): Operation<SampleToolsResult>;
  sampleSchema<T>(config: SampleSchemaConfig<T, TMessage>): Operation<SampleSchemaResult<T>>;
}

// -----------------------------------------------------------------------------
// ToolCtx — complete tool-facing contract (no index signature)
// -----------------------------------------------------------------------------

export interface BaseToolCtx {
  /** Scope-owned live cancellation bridge. Never persist or serialize it. */
  readonly signal: AbortSignal;
  /** Conversation messages visible to the current tool invocation. */
  readonly messages: readonly ChatMessage[];
  notify(message: string, progress?: number, level?: LogLevel): Operation<void>;
  log(level: LogLevel, message: string): Operation<void>;
}

type ElicitRequestFor<E> =
  ExtractElicitContextInput<E> extends undefined
    ? { message: string; interrupt?: PerCallInterruptOptions }
    : {
        message: string;
        context: ExtractElicitContextInput<E>;
        interrupt?: PerCallInterruptOptions;
      };

export interface ToolElicitCtx<TElicits extends ElicitsMap> {
  elicit<K extends keyof TElicits & string>(
    key: K,
    request: ElicitRequestFor<TElicits[K]>,
  ): Operation<
    ToolElicitResult<ExtractElicitContextInput<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>
  >;
}

export type ToolGenericSampleCtx = ToolSamplingCtx<ChatMessage> & {
  /** Generic request form used by named sample declarations. */
  sample(request: SampleRequest): Operation<NamedSampleResult>;
};

type SampleParsed<TSamples extends SamplesMap, K extends keyof TSamples> =
  TSamples[K] extends SampleDefinition<infer TOutputSchema>
    ? TOutputSchema extends undefined
      ? unknown
      : InferSchema<TOutputSchema>
    : unknown;

export type ToolNamedSampleCtx<TSamples extends SamplesMap> = ToolSamplingCtx<ChatMessage> & {
  sample(request: SampleRequest): Operation<NamedSampleResult>;
  sample<K extends keyof TSamples & string>(
    key: K,
    request: SampleRequest,
  ): Operation<NamedSampleResult<SampleParsed<TSamples, K>>>;
};

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
  /** Ordinary definitions execute through a callable Effection factory. */
  readonly execution: "ordinary";
  readonly name: TName;
  readonly description: string;
  readonly parameters: StandardSchemaV1<unknown, TParams>;
  readonly output?: StandardSchemaV1<unknown, TResult>;
  readonly elicits: NormalizedElicitsMap<TElicits>;
  readonly samples: TSamples extends SamplesMap
    ? NormalizedSamplesMap<TSamples>
    : Readonly<Record<string, never>>;
  readonly schemas: {
    readonly input: StandardSchemaV1<unknown, TParams>;
    readonly output?: StandardSchemaV1<unknown, TResult>;
  };
  /** Retained portable schema projections and digest-keyed validator catalog. */
  readonly artifacts: ToolSchemaArtifacts;
  readonly capabilities: { readonly elicitation: boolean; readonly sampling: boolean };
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly extensions: readonly ToolExtensionMetadata[];
  /** Complete execution-neutral identity and compiled interaction addresses. */
  readonly interfaceDigest: string;
  readonly bindings: ToolInteractionBindings;
}

/** Wire-boundary erased tool with its authored sample-schema evidence retained. */
export type RuntimeTool = ToolDefinition<string, any, any, any, any> & {
  readonly elicits: Readonly<Record<string, NormalizedElicitDefinition<unknown, unknown, unknown>>>;
  readonly samples: Readonly<Record<string, SampleDefinition<StandardSchemaV1 | undefined>>>;
};

export interface CreateToolBuilderBase<TName extends string> {
  description(desc: string): CreateToolBuilderWithDescription<TName>;
}

export interface CreateToolBuilderWithDescription<TName extends string> {
  parameters<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    projections?: SchemaProjectionOptions,
  ): CreateToolBuilderWithParams<
    TName,
    StandardSchemaV1.InferOutput<TSchema>,
    undefined,
    undefined,
    undefined
  >;
}

export interface CreateToolBuilderWithParams<
  TName extends string,
  TInput,
  TOutput = undefined,
  TElicits extends ElicitsMap | undefined = undefined,
  TSamples extends SamplesMap | true | undefined = undefined,
> {
  output<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    projections?: SchemaProjectionOptions,
  ): CreateToolBuilderWithParams<
    TName,
    TInput,
    StandardSchemaV1.InferOutput<TSchema>,
    TElicits,
    TSamples
  >;
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
