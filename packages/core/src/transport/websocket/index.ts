/**
 * WebSocket Transport Implementation
 *
 * This module provides a transport implementation using WebSocket
 * for bidirectional real-time communication.
 *
 * Unlike SSE+POST which uses:
 * - SSE for backend -> frontend
 * - POST for frontend -> backend
 *
 * WebSocket uses a single connection for both directions.
 * 
 * Uses @effectionx/websocket for clean, resource-oriented WebSocket handling.
 */

export {
  createWebSocketBackendTransport,
  type WebSocketBackendTransport,
  type WebSocketMessage,
} from "./backend.ts";

export { createWebSocketFrontendTransport } from "./frontend.ts";
