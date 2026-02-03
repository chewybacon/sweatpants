/**
 * Transport Middleware
 *
 * Transport middleware factories for different transport types.
 * Each middleware is a resource that:
 * 1. Connects automatically when yielded
 * 2. Decorates TransportApi with implementations
 * 3. Returns the transport role ("principal" | "operative")
 * 4. Disconnects automatically when scope exits
 *
 * @packageDocumentation
 */

export { MemoryPair } from "./memory.ts";

// TODO: Add these as they're implemented
// export { WebSocketPrincipal, WebSocketOperative } from "./websocket.ts";
// export { SSEPrincipal, SSEOperative } from "./sse.ts";
// export { WorkerPrincipal, WorkerOperative } from "./worker.ts";
