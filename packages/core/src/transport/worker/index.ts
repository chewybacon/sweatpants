/**
 * Worker Transport
 *
 * Web worker transport for running operations in isolated workers.
 * Uses @effectionx/worker for lifecycle management and cross-environment
 * compatibility (browser and Node.js).
 *
 * ## Architecture
 *
 * Supports two configurations based on which side acts as principal vs operative:
 *
 * ### Worker as Principal (most common)
 *
 * Worker sends requests (sample/elicit), host handles them:
 * - Host: `createWorkerOperative()` - spawns worker, handles requests
 * - Worker: `runWorkerPrincipal()` - sends requests, receives responses
 *
 * ```
 * Host (Operative)                    Worker (Principal)
 * ─────────────────────────────────────────────────────────
 *   │                                      │
 *   │ ◄──── send.stream(request) ──────── │ (worker initiates)
 *   │                                      │
 *   │ ───── ctx.progress(update) ───────► │ (with backpressure)
 *   │ ───── return response ────────────► │ (final value)
 * ```
 *
 * ### Host as Principal
 *
 * Host sends requests, worker handles them:
 * - Host: `createWorkerPrincipal()` - spawns worker, sends requests
 * - Worker: `runWorkerOperative()` - handles requests, returns responses
 *
 * ```
 * Host (Principal)                    Worker (Operative)
 * ─────────────────────────────────────────────────────────
 *   │                                      │
 *   │ ───── worker.send(request) ───────► │ (host initiates)
 *   │                                      │
 *   │ ◄──── return response ───────────── │ (final value)
 * ```
 *
 * Note: Progress streaming is only available when worker is principal.
 *
 * ## Usage (Worker as Principal - Common Case)
 *
 * ```typescript
 * // Host side
 * import { createWorkerOperative } from "@sweatpants/core/transport/worker";
 *
 * const { result } = yield* createWorkerOperative({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 *   requestHandler: function* (request, ctx) {
 *     yield* ctx.progress({ type: "progress", message: "Processing..." });
 *     if (request.type === "sample") {
 *       return yield* callLLM(request);
 *     }
 *     // ...
 *   }
 * });
 *
 * const toolResult = yield* result;
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
  type WorkerOperativeResult,
  type WorkerRequestHandler,
  type ForEachContext,
} from "./operative.ts";

// Host-side: Principal (sends requests to worker)
export {
  createWorkerPrincipal,
  type WorkerPrincipalOptions,
  type WorkerPrincipalResult,
  type WorkerPrincipalTransport,
} from "./principal.ts";

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
