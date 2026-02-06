/**
 * Worker-Side Exports
 *
 * This module contains exports that are meant to run INSIDE a web worker.
 * They depend on @effectionx/worker which uses Node.js worker_threads APIs.
 *
 * DO NOT import this module in browser/client code - it will fail to build.
 *
 * Use this from:
 * - Worker scripts (e.g., tool-worker.mjs)
 * - Server-side code that spawns workers
 *
 * @example Worker script
 * ```typescript
 * import { runWorker, createWorkerToolRegistry } from '@sweatpants/framework/chat/mcp-tools/worker'
 *
 * const registry = createWorkerToolRegistry()
 *   .register(myTool)
 *
 * runWorker(registry)
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// WORKER TYPES
// =============================================================================

export type {
  // MCP-specific worker types
  McpWorkerInitData,
  McpWorkerRequest,
  McpWorkerResponse,
  McpWorkerResult,
  McpProgressRequest,
  McpLogRequest,
  McpSampleRequest,
  McpElicitRequest,
  McpHostProgress,

  // Tool registry for workers
  WorkerToolRegistry,
  WorkerTool,
  WorkerToolContext,

  // Sample config types
  WorkerSampleConfig,
  WorkerSampleToolsConfig,
  WorkerSampleSchemaConfig,
} from './worker-types.ts'

// =============================================================================
// WORKER RUNNER (runs inside worker thread)
// =============================================================================

export {
  // Worker runner (runs inside worker)
  runWorker,
  createWorkerToolRegistry,
} from './worker-runner.ts'

// =============================================================================
// WORKER TOOL SESSION (host-side adapter for worker-based tools)
// =============================================================================

export {
  // Worker tool session adapter
  createWorkerToolSession,
  type WorkerToolSessionOptions,
} from './worker-tool-session.ts'
