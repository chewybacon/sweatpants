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
} from "../types/transport.ts";

// Core utilities
export { createTransportPair } from "./pair.ts";
export { createCorrelation, type CorrelatedTransport } from "./correlation.ts";
