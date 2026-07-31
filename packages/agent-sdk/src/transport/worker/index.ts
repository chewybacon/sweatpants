/**
 * Worker Transport
 *
 * Web worker transport for running tool sessions in isolated workers.
 * Uses @effectionx/worker for lifecycle management and cross-environment
 * compatibility (browser and Node.js).
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication:
 * - Worker sends sample/elicit requests via send.stream(request)
 * - Host receives requests via worker.forEach()
 * - Host sends an initial ready progress ACK before publishing the request event
 * - Host returns exactly one final response for each request
 *
 * ## Usage (Host Side)
 *
 * ```typescript
 * import { createWorkerPrincipal } from "@sweatpants/agent-sdk/transport/worker";
 *
 * const { result } = yield* createWorkerPrincipal({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 *   requestHandler: function* (request) {
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
 * import { runToolWorker } from "@sweatpants/agent-sdk/transport/worker";
 *
 * await runToolWorker(function* (initData, ctx) {
 *   // Sample the LLM through the host backchannel
 *   const response = yield* ctx.sample({
 *     messages: [{ role: "user", content: "Hello" }]
 *   });
 *
 *   return { greeting: response.completion.text };
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
  // Context type
  WorkerToolContext,
} from "./types.ts";

// Type guards
export { isProgressMessage, isLogMessage, isOutOfBandMessage } from "./types.ts";

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
export { runToolWorker, runRequestHandler, type ToolWorkerHandler } from "./runner.ts";

// Re-export ForEachContext from host.ts (we define it locally to avoid
// TypeScript resolution issues with the PR-based package)
export type { ForEachContext } from "./host.ts";
