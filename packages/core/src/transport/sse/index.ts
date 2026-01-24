/**
 * SSE+POST Transport Implementation
 *
 * This module provides a transport implementation using:
 * - Server-Sent Events (SSE) for backend -> frontend messages
 * - HTTP POST for frontend -> backend responses and progress
 *
 * This is the recommended transport for traditional HTTP infrastructure.
 * For real-time bidirectional communication, see the WebSocket transport.
 */

export {
  createSSEBackendTransport,
  type SSEBackendTransport,
  type SSEBackendTransportOptions,
} from "./backend.ts";

export {
  createSSEFrontendTransport,
  type SSEFrontendTransportOptions,
} from "./frontend.ts";
