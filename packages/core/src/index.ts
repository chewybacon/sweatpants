// Re-export all types
export * from "./types/index.ts";

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
  validateProgramBindingsForRelease,
  validateProgramIdentityProvenance,
  type GeneratedProgramArtifactIdentityV1,
  type GeneratedProgramInterfaceIdentityV1,
  type ProgramArtifactIdentityInputV1,
  type ProgramIdentityProvenanceV1,
} from "@sweatpants/session-contract";

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
  defineEffect,
  effectCatalogEntries,
  effectRuntimeValidators,
  buildToolSchemaArtifacts,
  isStandardSchema,
  toPortableSchema,
  type AnyToolContract,
  type DefineEffectOptions,
  type DurableEffectRuntimeValidators,
  type DurableToolDefinition,
  type LoweredSchema,
  type PortableSchemaOptions,
  type ToolContract,
  type ToolElicitSchemaArtifact,
  type ToolExecutionKind,
  type ToolSchemaArtifacts,
  type ToolSchemaArtifactInputs,
  type InferSchema,
  type InferSchemaInput,
  type ExtractElicitResponseInput,
  type CreateDurableToolBuilderBase,
  type CreateDurableToolBuilderReady,
  type CreateDurableToolBuilderWithDescription,
  type CreateDurableToolBuilderWithIdentity,
  type CreateDurableToolBuilderWithParameters,
  type DurableProgramContextFor,
  type FluentDurableTool,
  type LogLevel,
  type ToolCtx,
  type BaseToolCtx,
  type ToolElicitResult,
  type WireElicitResult,
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
  type SampleResultBase,
  type SampleResultWithParsed,
  type SampleResultWithToolCalls,
  type WireSampleResult,
  type ElicitExchange,
  type SampleExchange,
  type ToolMessage,
  type ToolExtension,
  type ToolExtensionMetadata,
  type ToolDefinition,
  type RuntimeTool,
  type CreateToolBuilderBase,
  type CreateToolBuilderWithDescription,
  type CreateToolBuilderWithParams,
  type CreateToolBuilderWithElicits,
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
  ElicitPayloadSchema,
  ElicitResultSchema,
  NotifyPayloadSchema,
  NotifyResultSchema,
  SamplePayloadSchema,
  SampleResultSchema,
  SampleMessageSchema,
  type ElicitOptions,
  type ElicitResult,
  type NotifyOptions,
  type NotifyResult,
  type SampleOptions,
  type SampleResult,
  type SampleMessage,
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
//   @sweatpants/core/transport/worker
//
// =============================================================================
