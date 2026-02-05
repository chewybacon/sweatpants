/**
 * Unified Transport Factory
 *
 * Provides a single entry point for creating transports across all supported
 * implementations (WebSocket, SSE, Worker, Memory).
 *
 * ## Usage
 *
 * ```typescript
 * // WebSocket Principal
 * const transport = yield* createTransport({
 *   type: 'websocket',
 *   role: 'principal',
 *   url: 'wss://example.com/socket'
 * });
 *
 * // SSE Operative
 * const transport = yield* createTransport({
 *   type: 'sse',
 *   role: 'operative',
 *   sseUrl: '/events',
 *   responseUrl: '/respond'
 * });
 *
 * // Worker Operative (host handles worker requests)
 * const { result } = yield* createTransport({
 *   type: 'worker',
 *   role: 'operative',
 *   workerUrl: './worker.js',
 *   initData: { toolName: 'greet', params: {}, sessionId: '123' },
 *   requestHandler: function* (req, ctx) { ... }
 * });
 *
 * // Memory (returns pair)
 * const [principal, operative] = yield* createTransport({
 *   type: 'memory',
 *   role: 'pair'
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { Operation } from "effection";
import type {
  PrincipalTransport,
  OperativeTransport,
} from "../types/transport.ts";
import { createWebSocketPrincipal } from "./websocket/principal.ts";
import { createWebSocketOperative } from "./websocket/operative.ts";
import { createSSEPrincipal, type SSEPrincipalOptions } from "./sse/principal.ts";
import { createSSEOperative, type SSEOperativeOptions } from "./sse/operative.ts";
import {
  createWorkerPrincipal,
  type WorkerPrincipalOptions,
} from "./worker/principal.ts";
import {
  createWorkerOperative,
  type WorkerOperativeOptions,
} from "./worker/operative.ts";
import type {
  WorkerPrincipalResult,
  WorkerOperativeResult,
} from "./worker/types.ts";
import { createTransportPair } from "./pair.ts";

// =============================================================================
// TYPES
// =============================================================================

export type TransportRole = "principal" | "operative";
export type TransportType = "websocket" | "sse" | "worker" | "memory";

// === WebSocket Options ===

export interface WebSocketPrincipalConfig {
  type: "websocket";
  role: "principal";
  url: string;
}

export interface WebSocketOperativeConfig {
  type: "websocket";
  role: "operative";
  url: string;
}

// === SSE Options ===

export interface SSEPrincipalConfig {
  type: "sse";
  role: "principal";
  sseUrl: string;
  postUrl: string;
  fetch?: typeof fetch;
}

export interface SSEOperativeConfig {
  type: "sse";
  role: "operative";
  sseUrl: string;
  responseUrl: string;
  fetch?: typeof fetch;
}

// === Worker Options ===

export interface WorkerPrincipalConfig extends Omit<WorkerPrincipalOptions, never> {
  type: "worker";
  role: "principal";
}

export interface WorkerOperativeConfig extends Omit<WorkerOperativeOptions, never> {
  type: "worker";
  role: "operative";
}

// === Memory Options ===

export interface MemoryPairConfig {
  type: "memory";
  role: "pair";
}

// === Discriminated Union ===

export type TransportConfig =
  | WebSocketPrincipalConfig
  | WebSocketOperativeConfig
  | SSEPrincipalConfig
  | SSEOperativeConfig
  | WorkerPrincipalConfig
  | WorkerOperativeConfig
  | MemoryPairConfig;

// =============================================================================
// OVERLOADED FACTORY
// =============================================================================

/**
 * Create a WebSocket principal transport.
 */
export function createTransport(
  config: WebSocketPrincipalConfig
): Operation<PrincipalTransport>;

/**
 * Create a WebSocket operative transport.
 */
export function createTransport(
  config: WebSocketOperativeConfig
): Operation<OperativeTransport>;

/**
 * Create an SSE principal transport.
 */
export function createTransport(
  config: SSEPrincipalConfig
): Operation<PrincipalTransport>;

/**
 * Create an SSE operative transport.
 */
export function createTransport(
  config: SSEOperativeConfig
): Operation<OperativeTransport>;

/**
 * Create a worker principal transport (host sends requests to worker).
 */
export function createTransport<T = unknown>(
  config: WorkerPrincipalConfig
): Operation<WorkerPrincipalResult<T>>;

/**
 * Create a worker operative transport (host handles requests from worker).
 */
export function createTransport<T = unknown>(
  config: WorkerOperativeConfig
): Operation<WorkerOperativeResult<T>>;

/**
 * Create a connected memory transport pair.
 */
export function createTransport(
  config: MemoryPairConfig
): Operation<[PrincipalTransport, OperativeTransport]>;

/**
 * Create a transport based on configuration.
 *
 * This unified factory delegates to the appropriate transport-specific
 * constructor based on the `type` and `role` fields.
 */
export function createTransport<T = unknown>(
  config: TransportConfig
): Operation<
  | PrincipalTransport
  | OperativeTransport
  | WorkerPrincipalResult<T>
  | WorkerOperativeResult<T>
  | [PrincipalTransport, OperativeTransport]
> {
  switch (config.type) {
    case "websocket":
      if (config.role === "principal") {
        return createWebSocketPrincipal(config.url);
      } else {
        return createWebSocketOperative(config.url);
      }

    case "sse":
      if (config.role === "principal") {
        const sseOptions: SSEPrincipalOptions = {
          sseUrl: config.sseUrl,
          postUrl: config.postUrl,
        };
        if (config.fetch !== undefined) {
          sseOptions.fetch = config.fetch;
        }
        return createSSEPrincipal(sseOptions);
      } else {
        const sseOptions: SSEOperativeOptions = {
          sseUrl: config.sseUrl,
          responseUrl: config.responseUrl,
        };
        if (config.fetch !== undefined) {
          sseOptions.fetch = config.fetch;
        }
        return createSSEOperative(sseOptions);
      }

    case "worker":
      if (config.role === "principal") {
        const { type: _type, role: _role, ...workerOptions } = config;
        return createWorkerPrincipal<T>(workerOptions);
      } else {
        const { type: _type, role: _role, ...workerOptions } = config;
        return createWorkerOperative<T>(workerOptions);
      }

    case "memory":
      return createTransportPair();
  }
}
