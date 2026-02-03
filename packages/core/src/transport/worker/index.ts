/**
 * Worker Transport
 *
 * Web worker transport for running tool sessions in isolated workers.
 * Uses @effectionx/worker for lifecycle management and cross-environment
 * compatibility (browser and Node.js).
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication with progress streaming:
 * - Worker sends requests via send.stream() (sample/elicit)
 * - Host receives requests via worker.forEach()
 * - Host sends progress via ctx.progress() (with backpressure)
 * - Worker consumes progress updates and receives final response
 *
 * ## Usage (Host Side)
 *
 * ```typescript
 * import { createWorkerPrincipal } from "@sweatpants/core/transport/worker";
 *
 * const { result } = yield* createWorkerPrincipal({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 *   requestHandler: function* (request, ctx) {
 *     // Send progress updates (with backpressure)
 *     yield* ctx.progress({ type: "progress", message: "Processing..." });
 *     
 *     // Handle request and return response
 *     if (request.type === "sample") {
 *       return yield* callLLM(request);
 *     }
 *     // ...
 *   }
 * });
 *
 * // Wait for final result
 * const toolResult = yield* result;
 * ```
 *
 * ## Usage (Worker Side)
 *
 * ```typescript
 * import { runToolWorker } from "@sweatpants/core/transport/worker";
 *
 * await runToolWorker(function* (initData, ctx) {
 *   // Sample the LLM (progress comes from host via the stream)
 *   const response = yield* ctx.sample({
 *     messages: [{ role: "user", content: "Hello" }]
 *   });
 *
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
  WorkerSampleRequest,
  WorkerElicitRequest,
  // Response types
  WorkerResponse,
  WorkerSampleResponse,
  WorkerElicitResponse,
  // Progress messages (now in-band)
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

// Host-side transport
export {
  createWorkerPrincipal,
  generateRequestId,
  createSampleResponse,
  createElicitResponse,
  type WorkerPrincipalOptions,
  type WorkerPrincipalResult,
  type WorkerRequestHandler,
} from "./host.ts";

// Worker-side runner
export {
  runToolWorker,
  runRequestHandler,
  type ToolWorkerHandler,
} from "./runner.ts";

// Re-export ForEachContext from host.ts (we define it locally to avoid
// TypeScript resolution issues with the PR-based package)
export type { ForEachContext } from "./host.ts";
