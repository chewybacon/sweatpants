/**
 * Transport Middleware
 *
 * Transport middleware factories for different transport types.
 * Each middleware is an Operation that:
 * 1. Sets up the connection and any required state
 * 2. Returns a decoration object for TransportApi
 *
 * Use with initTransport() to initialize and get typed interface.
 *
 * @packageDocumentation
 */

export { MemoryPair } from "./memory.ts";
export { WebSocketPrincipal, WebSocketOperative, type WebSocketOptions } from "./websocket.ts";
export { SSEPrincipal, SSEOperative, type SSEPrincipalOptions, type SSEOperativeOptions } from "./sse.ts";
export {
  WorkerPrincipal,
  WorkerOperative,
  type WorkerOptions,
  type WorkerTransportResource,
} from "./worker.ts";
