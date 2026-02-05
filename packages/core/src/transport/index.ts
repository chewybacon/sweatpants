// Types
export type {
  Transport,
  PrincipalTransport,
  OperativeTransport,
  TransportRequest,
  ProgressMessage,
  ResponseMessage,
  PrincipalIncoming,
  PrincipalOutgoing,
  OperativeIncoming,
  OperativeOutgoing,
  InterruptMessage,
  ElicitResponse,
  NotifyResponse,
  SampleResponse,
  RequestKind,
  ResponseByKind,
} from "../types/transport.ts";

// Type guards and helpers
export {
  isProgressMessage,
  isResponseMessage,
  isElicitResponse,
  isNotifyResponse,
  isSampleResponse,
  createResponseMessage,
} from "../types/transport.ts";

// Core utilities
export { createTransportPair } from "./pair.ts";
export { createCorrelation, type CorrelatedTransport } from "./correlation.ts";

// Unified factory
export {
  createTransport,
  type TransportRole,
  type TransportType,
  type TransportConfig,
  type WebSocketPrincipalConfig,
  type WebSocketOperativeConfig,
  type SSEPrincipalConfig,
  type SSEOperativeConfig,
  type WorkerPrincipalConfig,
  type WorkerOperativeConfig,
  type MemoryPairConfig,
} from "./factory.ts";
