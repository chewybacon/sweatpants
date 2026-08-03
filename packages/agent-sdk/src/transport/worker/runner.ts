/**
 * Worker-Side Runner Utilities
 *
 * Provides utilities for running tool handlers inside a web worker.
 * This module bridges the worker's message-based API to the tool context interface.
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication:
 * - Worker sends sample/elicit requests to the host via send.stream(request)
 * - Host receives requests via worker.forEach()
 * - Host first sends a ready progress ACK, then later returns the single response
 *
 * This enables the tool session pattern where:
 * - Tool (in worker) sends sample/elicit requests to host
 * - Host publishes a session event only after the worker-side stream is armed
 * - Worker resumes once the host returns the response
 *
 * @packageDocumentation
 */

import { workerMain } from "@effectionx/worker";
import type { Json, JsonObject } from "@sweatpants/foundation";
import { useAbortSignal, type Operation, type Subscription } from "effection";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerSampleRequest,
  WorkerSampleResponse,
  WorkerElicitRequest,
  WorkerElicitResponse,
  WorkerResult,
  WorkerInitData,
  WorkerProgressMessage,
  WorkerLogMessage,
  WorkerToolContext,
} from "./types.ts";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Handler function that receives init data and context, returns tool result.
 */
export type ToolWorkerHandler<T = unknown> = (
  initData: WorkerInitData,
  ctx: WorkerToolContext,
) => Operation<T>;

// =============================================================================
// WORKER RUNNER
// =============================================================================

/**
 * Run a tool handler inside a web worker.
 *
 * This function sets up bidirectional communication using @effectionx/worker:
 * - Tool sends requests (sample/elicit) via send.stream(request)
 * - Host sends an initial ready progress ACK to arm the response stream
 * - Host returns exactly one final response for each request
 * - Tool progress/logging remains local to the worker context
 *
 * The handler receives:
 * - initData: The initialization data passed from the host
 * - ctx: A WorkerToolContext for sampling, eliciting, logging, and progress
 *
 * @param handler - Function that executes the tool and returns its result
 */
export async function runToolWorker<T = unknown>(handler: ToolWorkerHandler<T>): Promise<void> {
  // Type parameters for workerMain:
  // TSend = never (host doesn't send requests to worker in our model)
  // TRecv = never (worker doesn't respond to host requests)
  // TReturn = WorkerResult<T> (final result from worker)
  // TData = WorkerInitData (init data)
  // WRequest = WorkerRequest (worker sends to host)
  // WResponse = WorkerResponse (host sends back to worker)
  await workerMain<never, never, WorkerResult<T>, WorkerInitData, WorkerRequest, WorkerResponse>(
    function* ({ data: initData, send }) {
      // Request ID counter
      let requestIdCounter = 0;

      /**
       * Generate a unique request ID.
       */
      function generateRequestId(): string {
        return `${initData.sessionId}:req:${++requestIdCounter}`;
      }

      /**
       * Send a request to the host and wait for the final response.
       *
       * The host sends one initial progress ACK before publishing the corresponding
       * session event. Consuming that progress item proves this worker-side stream
       * is armed, so immediate host responses cannot race the response listener.
       */
      function* sendRequestToHost<TReq extends WorkerRequest, TRes extends WorkerResponse>(
        request: TReq,
        onProgress?: (progress: WorkerProgressMessage) => void,
      ): Operation<TRes> {
        const subscription: Subscription<WorkerProgressMessage, WorkerResponse> =
          yield* send.stream<WorkerProgressMessage>(request);

        let next = yield* subscription.next();
        while (!next.done) {
          onProgress?.(next.value);
          next = yield* subscription.next();
        }

        return next.value as TRes;
      }

      /**
       * Create the tool context for the handler.
       */
      const signal = yield* useAbortSignal();
      const ctx: WorkerToolContext = {
        signal,
        *sample(options): Operation<WorkerSampleResponse> {
          const id = generateRequestId();
          const request: WorkerSampleRequest = {
            id,
            type: "sample",
            messages: options.messages,
            ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
            ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
            ...(options.modelPreferences !== undefined && {
              modelPreferences: options.modelPreferences,
            }),
            ...(options.tools !== undefined && { tools: options.tools }),
            ...(options.toolChoice !== undefined && { toolChoice: options.toolChoice }),
            ...(options.schema !== undefined && { schema: options.schema }),
          };

          return yield* sendRequestToHost<WorkerSampleRequest, WorkerSampleResponse>(request);
        },

        *elicit(
          key: string,
          options: {
            message: string;
            schema: JsonObject;
            context?: Json;
          },
        ): Operation<WorkerElicitResponse> {
          const id = generateRequestId();
          const request: WorkerElicitRequest = {
            id,
            type: "elicit",
            key,
            message: options.message,
            schema: options.schema,
            ...(options.context !== undefined && { context: options.context }),
          };

          return yield* sendRequestToHost<WorkerElicitRequest, WorkerElicitResponse>(request);
        },

        // Progress is now sent FROM host TO worker, so this becomes a no-op log
        // The worker can still call this for logging purposes, but it won't
        // affect the host's progress tracking
        progress(message: string, progressValue?: number): void {
          // Log progress locally for debugging
          console.log(
            `[Worker Progress] ${message}${progressValue !== undefined ? ` (${progressValue * 100}%)` : ""}`,
          );
        },

        log(level: WorkerLogMessage["level"], message: string): void {
          // Log locally - in future could be sent via a dedicated log channel
          const logFn =
            level === "error"
              ? console.error
              : level === "warning"
                ? console.warn
                : level === "debug"
                  ? console.debug
                  : console.log;
          logFn(`[Worker ${level.toUpperCase()}] ${message}`);
        },
      };

      try {
        // Execute the handler
        const result = yield* handler(initData, ctx);

        return {
          type: "success",
          value: result,
        } as WorkerResult<T>;
      } catch (error) {
        const err = error as Error;
        return {
          type: "error",
          error: {
            name: err.name,
            message: err.message,
            stack: err.stack,
          },
        };
      }
    },
  );
}

// =============================================================================
// SIMPLE REQUEST HANDLER RUNNER
// =============================================================================

/**
 * Simpler runner for when the host drives the interaction.
 *
 * In this model:
 * - Host sends requests (like "execute tool step") via worker.send()
 * - Worker processes and returns responses
 *
 * This is useful for stateless tool execution where each request is independent.
 *
 * @param requestHandler - Function that handles incoming requests
 */
export async function runRequestHandler(
  requestHandler: (request: WorkerRequest) => Operation<WorkerResponse>,
): Promise<void> {
  await workerMain<WorkerRequest, WorkerResponse, WorkerResult<void>, WorkerInitData>(function* ({
    messages,
  }) {
    try {
      yield* messages.forEach(function* (request: WorkerRequest): Operation<WorkerResponse> {
        return yield* requestHandler(request);
      });

      return { type: "success", value: undefined };
    } catch (error) {
      const err = error as Error;
      return {
        type: "error",
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      };
    }
  });
}
