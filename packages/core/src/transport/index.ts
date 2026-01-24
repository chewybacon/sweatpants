/**
 * Transport layer for backend-frontend communication.
 *
 * This module exports the transport interfaces and utilities.
 * Specific implementations (SSE, WebSocket) are in their own submodules.
 */

export type {
  BackendTransport,
  FrontendTransport,
  IncomingMessage,
  TransportRequest,
  InterruptMessage,
  ElicitResponse,
  NotifyResponse,
} from "../types/transport.ts";
