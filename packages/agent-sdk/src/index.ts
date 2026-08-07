// Re-export all types
export * from "./types/index.ts";
export * from "./schema/roles.ts";

// Content-addressed resources, guidance, readers, and build-time identity generation.
export * from "./resource/index.ts";

// Portable agent manifests paired with explicit local runtime bindings.
export * from "./agent/index.ts";
export {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_DOMAIN,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  PROGRAM_INTERFACE_GENERATOR_VERSION,
  PROGRAM_INTERFACE_IDENTITY_DOMAIN,
  PROGRAM_INTERFACE_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  createInterfaceDerivedPinnedDurableProgram,
  deriveProgramArtifactDigest,
  generateProgramArtifactIdentity,
  generateProgramInterfaceIdentity,
  normalizeProgramArtifactIdentityInput,
  verifyProgramBindingsForRelease,
  verifyProgramIdentityProvenance,
  type GeneratedProgramArtifactIdentityV1,
  type GeneratedProgramInterfaceIdentityV1,
  type ProgramArtifactIdentityInputV1,
  type ProgramIdentityProvenanceV1,
} from "@sweatpants/durable-execution";

// Re-export transport utilities and types
export {
  createTransportPair,
  createCorrelation,
  type Transport,
  type PrincipalTransport,
  type OperativeTransport,
  type TransportRequest,
  type ProgressMessage,
  type ResponseMessage,
  type PrincipalIncoming,
  type PrincipalOutgoing,
  type OperativeIncoming,
  type OperativeOutgoing,
  type InterruptMessage,
  type CorrelatedTransport,
} from "./transport/index.ts";

// Re-export tool utilities and types
export {
  createTool,
  createDurableTool,
  SampleValidationError,
  SCHEMA_TOOL_NAME,
  completeElicitExchange,
  completeSampleExchange,
  createRawSampleExchange,
  createStructuredSampleExchange,
  parseElicitExchangeCompletion,
  projectModelSampleCompletion,
  computeToolInterfaceDigest,
  defineDurableContextExtension,
  assertDurableExtensionDeclarations,
  defineEffect,
  effectCatalogEntries,
  effectRuntimeValidators,
  buildToolSchemaArtifacts,
  isStandardSchema,
  isExecutableToolContract,
  projectToolContract,
  toPortableSchema,
  type AnyToolContract,
  type DefineEffectOptions,
  type DurableContextExtension,
  type DurableContextExtensionOptions,
  type DurableEffectRuntimeValidators,
  type DurableClientApi,
  type DurableClientMethod,
  type DurableClientShape,
  type DurableExtensionContext,
  type DurableExtensionMap,
  type DurableToolDefinition,
  type ExtensionClient,
  type LoweredSchema,
  type PortableSchemaOptions,
  type ToolContract,
  type ToolElicitSchemaArtifact,
  type ToolExecutionKind,
  type ToolSchemaArtifacts,
  type ToolSchemaArtifactInputs,
  type CompleteElicitExchangeOptions,
  type CompleteSampleExchangeOptions,
  type InferSchema,
  type InferSchemaInput,
  type ExtractElicitResponseInput,
  type ExtractElicitContextInput,
  type CreateDurableToolBuilderBase,
  type CreateDurableToolBuilderReady,
  type CreateDurableToolBuilderWithDescription,
  type CreateDurableToolBuilderWithIdentity,
  type CreateDurableToolBuilderWithParameters,
  type DurableProgramContextFor,
  type LogLevel,
  type ToolCtx,
  type BaseToolCtx,
  type ToolSamplingCtx,
  type ToolElicitResult,
  type ElicitExchangeCompletion,
  type ElicitDefinition,
  type ElicitEntry,
  type ElicitsMap,
  type ExtractElicitResponse,
  type ExtractElicitContext,
  type ExtractElicitResponseSchema,
  type ExtractElicitContextSchema,
  type NormalizedElicitDefinition,
  type NormalizedElicitsMap,
  type SampleDefinition,
  type SamplesMap,
  type SampleRequest,
  type SampleRequestOptions,
  type NamedSampleResult,
  type SampleResultBase,
  type SampleResultWithParsed,
  type SampleResultWithToolCalls,
  type SampleToolsResult,
  type SampleSchemaResult,
  type ToolSampleConfig,
  type SampleConfigPlainPrompt,
  type SampleConfigPlainMessages,
  type SampleConfigSchemaPrompt,
  type SampleConfigSchemaMessages,
  type SampleConfigToolsPrompt,
  type SampleConfigToolsMessages,
  type SampleToolsConfig,
  type SampleSchemaConfig,
  type SampleExchangeCompletion,
  type SampleExchangeCompletionBase,
  type ParsedSampleExchangeCompletion,
  type ToolCallSampleExchangeCompletion,
  type ModelPreferences,
  type SamplingToolDefinition,
  type SamplingToolChoice,
  type ElicitExchange,
  type SampleExchange,
  type ToolExtension,
  type ToolExtensionMetadata,
  type ToolDefinition,
  type RuntimeTool,
  type CreateToolBuilderBase,
  type CreateToolBuilderWithDescription,
  type CreateToolBuilderWithParams,
  type PerCallInterruptOptions,
} from "./tool/index.ts";

// Re-export context utilities
export { TransportContext } from "./context/index.ts";

// Re-export built-in operations and types
export {
  SweatpantsApi,
  elicit,
  notify,
  sample,
  SweatpantsProtocol,
  type ElicitOptions,
  type ElicitResult,
  type NotifyOptions,
  type NotifyResult,
  type SampleOptions,
  type SampleResult,
  type SampleMessage,
  type BuiltinElicitPayload,
  type BuiltinElicitResult,
  type BuiltinNotifyPayload,
  type BuiltinNotifyResult,
  type BuiltinSampleMessage,
  type BuiltinSamplePayload,
  type BuiltinSampleResult,
} from "./builtins/index.ts";

// Re-export protocol utilities and types
export {
  createProtocol,
  createImplementation,
  serveProtocol,
  type Method,
  type Methods,
  type Protocol,
  type InvocationArgs,
  type InvocationResult,
  type MethodHandler,
  type MethodHandlers,
  type Implementation,
  type Handle,
  type Inspector,
} from "./protocol/index.ts";

// =============================================================================
// WORKER TRANSPORT
// =============================================================================
//
// Worker transport is NOT exported from the main entry to avoid pulling
// @effectionx/worker (which uses Node.js worker_threads) into browser bundles.
//
// For worker transport functionality, import from:
//   @sweatpants/agent-sdk/transport/worker
//
// =============================================================================
