// Re-export all types
export * from "./types/index.ts";

// Re-export transport utilities and types
export {
  createTransportPair,
  createCorrelation,
  // Type guards and helpers
  isProgressMessage,
  isResponseMessage,
  isElicitResponse,
  isNotifyResponse,
  isSampleResponse,
  createResponseMessage,
  // Types
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
  type RequestKind,
  type ResponseByKind,
  type SampleResponse,
  type ElicitResponse,
  type NotifyResponse,
} from "./transport/index.ts";

// Re-export tool utilities and types
export {
  createTool,
  type ToolConfig,
  type ToolImplFn,
  type Tool,
  type ToolMiddleware,
  type ToolFactoryWithImpl,
  type ToolFactoryWithoutImpl,
  type ContextBinding,
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

// Re-export agent utilities and types
export {
  createAgent,
  type AgentConfig,
  type Agent,
  type AgentFactory,
  type AgentFactoryWithConfig,
  type AgentFactoryWithoutConfig,
  type AgentMiddleware,
  type AnyToolFactory,
  type ToolFromFactory,
  type InputFromFactory,
  type OutputFromFactory,
} from "./agent/index.ts";

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

// Re-export worker transport utilities and types
export {
  // Host-side
  createWorkerPrincipal,
  generateRequestId,
  createSampleResponse,
  createElicitResponse,
  type WorkerPrincipalOptions,
  type WorkerPrincipalResult,
  type WorkerRequestHandler,
  type ForEachContext,
  // Worker-side
  runToolWorker,
  runRequestHandler,
  type ToolWorkerHandler,
  // Types
  type WorkerRequest,
  type WorkerSampleRequest,
  type WorkerElicitRequest,
  type WorkerResponse,
  type WorkerSampleResponse,
  type WorkerElicitResponse,
  type WorkerProgressMessage,
  type WorkerLogMessage,
  type WorkerOutOfBandMessage,
  type WorkerInitData,
  type WorkerResult,
  type WorkerSuccessResult,
  type WorkerErrorResult,
  type WorkerCancelledResult,
  type WorkerMessage,
  type WorkerMessageRole,
  type WorkerContentBlock,
  type WorkerTextContent,
  type WorkerToolUseContent,
  type WorkerToolResultContent,
  type WorkerModelPreferences,
  type WorkerToolDefinition,
  type WorkerToolChoice,
  type WorkerToolCall,
  type WorkerToolContext,
  // Type guards
  isWorkerProgressMessage,
  isWorkerLogMessage,
  isWorkerOutOfBandMessage,
} from "./transport/worker/index.ts";
