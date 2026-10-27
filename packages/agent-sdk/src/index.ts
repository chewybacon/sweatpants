export { type ToolDefinition } from "./tool/definition.ts";
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

// Re-export tool utilities and types
export {
  createTool,
  createDurableTool,
  INTERACTION_BINDING_DOMAIN,
  compileInteractionBinding,
  compileToolInteractionBindings,
  parseInteractionBinding,
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
  implementEffect,
  effectCatalogEntries,
  effectRuntimeValidators,
  buildToolSchemaArtifacts,
  isStandardSchema,
  isExecutableToolContract,
  projectToolContract,
  toPortableSchema,
  type AnyToolContract,
  type ElicitBindingEvidence,
  type InteractionBinding,
  type ToolInteractionBindings,
  type DefineEffectOptions,
  type DurableContextExtension,
  type DurableContextExtensionOptions,
  type DurableEffectRuntimeValidators,
  type DurableClientApi,
  type DurableClientMethod,
  type DurableClientShape,
  type DurableExtensionContext,
  type DurableExtensionMap,
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
  type NormalizedSamplesMap,
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
  type RuntimeTool,
  type CreateToolBuilderBase,
  type CreateToolBuilderWithDescription,
  type CreateToolBuilderWithParams,
  type PerCallInterruptOptions,
} from "./tool/index.ts";

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

export * from "./tool/documents.ts";

// Portable tool execution and native effect registration.
export {
  createJournalToolContext,
  validateToolAnswer,
  JournalEffectDeclarationError,
} from "./tool/journal-compiler.ts";
export type { JournalRequest, JournalToolContext, ToolResult } from "./tool/journal-compiler.ts";
export { createToolEffects, toolEffectValidation } from "./tool/tool-effect-middleware.ts";
export type { ToolEffectSignature, ToolEffectHandlers } from "./tool/tool-effect-middleware.ts";
export type { SchemaProjectionOptions } from "./tool/types.ts";
