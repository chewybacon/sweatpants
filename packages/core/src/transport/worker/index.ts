/**
 * Worker Transport
 *
 * Web worker transport for running operations in isolated workers.
 * Uses @effectionx/worker for lifecycle management and cross-environment
 * compatibility (browser and Node.js).
 *
 * Returns standard `PrincipalTransport` / `OperativeTransport` interfaces
 * that can be composed with `createCorrelation()` like other transports.
 *
 * ## Architecture
 *
 * Supports two configurations based on which side acts as principal vs operative:
 *
 * ### Worker as Principal (most common)
 *
 * Worker sends requests (sample/elicit), host handles them:
 * - Host: `createWorkerOperative()` - spawns worker, returns OperativeTransport
 * - Worker: `runWorkerPrincipal()` - sends requests, receives responses
 *
 * ### Host as Principal
 *
 * Host sends requests, worker handles them:
 * - Host: `createWorkerPrincipal()` - spawns worker, returns PrincipalTransport
 * - Worker: `runWorkerOperative()` - handles requests, returns responses
 *
 * Note: Progress streaming is only available when worker is principal.
 *
 * ## Usage (Worker as Principal - Common Case)
 *
 * ```typescript
 * // Host side
 * import { createWorkerOperative } from "@sweatpants/core/transport/worker";
 * import { each } from "effection";
 *
 * const workerOp = yield* createWorkerOperative({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 * });
 *
 * // Access transport (standard OperativeTransport interface)
 * const transport = workerOp.transport;
 *
 * // Handle requests via transport
 * yield* spawn(function* () {
 *   for (const request of yield* each(transport)) {
 *     // Handle request, send response
 *     yield* transport.send({ type: 'response', id: request.id, ... });
 *     yield* each.next();
 *   }
 * });
 *
 * // Await final result
 * const toolResult = yield* workerOp;
 * ```
 *
 * ```typescript
 * // Worker side
 * import { runWorkerPrincipal } from "@sweatpants/core/transport/worker";
 *
 * await runWorkerPrincipal(function* (initData, ctx) {
 *   const response = yield* ctx.sample({
 *     messages: [{ role: "user", content: "Hello" }]
 *   });
 *   return { greeting: response.text };
 * });
 * ```
 *
 * @packageDocumentation
 */

// Types
export type {
  // Request types
  WorkerRequest,
  WorkerRequestBase,
  WorkerSampleRequest,
  WorkerElicitRequest,
  // Response types
  WorkerResponse,
  WorkerResponseBase,
  WorkerSampleResponse,
  WorkerElicitResponse,
  // Progress messages
  WorkerProgressMessage,
  WorkerLogMessage,
  WorkerOutOfBandMessage,
  // Init and result types
  WorkerInitData,
  WorkerResult,
  WorkerSuccessResult,
  WorkerErrorResult,
  WorkerCancelledResult,
  // Supporting types
  WorkerMessage,
  WorkerMessageRole,
  WorkerContentBlock,
  WorkerTextContent,
  WorkerToolUseContent,
  WorkerToolResultContent,
  WorkerModelPreferences,
  WorkerToolDefinition,
  WorkerToolChoice,
  WorkerToolCall,
  // Context type
  WorkerToolContext,
} from "./types.ts";

// Type guards
export {
  isWorkerProgressMessage,
  isWorkerLogMessage,
  isWorkerOutOfBandMessage,
} from "./types.ts";

// Host-side: Operative (handles requests from worker)
export {
  createWorkerOperative,
  generateRequestId,
  createSampleResponse,
  createElicitResponse,
  type WorkerOperativeOptions,
  type ForEachContext,
} from "./operative.ts";

// Host-side: Principal (sends requests to worker)
export {
  createWorkerPrincipal,
  type WorkerPrincipalOptions,
  type WorkerPrincipalTransport,
} from "./principal.ts";

// Transport result types (from types.ts)
export type {
  WorkerOperativeResult,
  WorkerPrincipalResult,
  WorkerProgressData,
} from "./types.ts";

// Worker-side runners
export {
  runWorkerPrincipal,
  runWorkerOperative,
  type WorkerPrincipalHandler,
  type WorkerOperativeHandler,
  // Deprecated
  runToolWorker,
  runRequestHandler,
  type ToolWorkerHandler,
} from "./runner.ts";
