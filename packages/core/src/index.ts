/**
 * @sweatpants/core
 *
 * Core primitives for the Sweatpants agent framework.
 *
 * This package provides:
 * - Transport interfaces for backend-frontend communication
 * - Data model types for conversations and messages
 * - Protocol utilities (coming soon)
 */

// Types
export * from "./types/index.ts";

// Transport (re-export interface types)
export type {
  BackendTransport,
  FrontendTransport,
  IncomingMessage,
  TransportRequest,
  InterruptMessage,
} from "./transport/index.ts";
