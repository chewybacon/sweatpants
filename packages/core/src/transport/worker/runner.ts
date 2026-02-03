/**
 * Worker-Side Runner Utilities
 *
 * Provides utilities for running handlers inside a web worker, supporting
 * both principal and operative roles.
 *
 * ## Principal Role (runWorkerPrincipal)
 *
 * Worker acts as principal - sends requests (sample/elicit) to host:
 * - Worker sends requests via send.stream()
 * - Host receives requests via worker.forEach()
 * - Host sends progress via ctx.progress()
 * - Worker receives progress updates and final response
 *
 * ## Operative Role (runWorkerOperative)
 *
 * Worker acts as operative - handles requests from host:
 * - Host sends requests via worker.send()
 * - Worker receives requests via messages.forEach()
 * - Worker processes and returns responses
 *
 * @packageDocumentation
 */

import { workerMain } from "@effectionx/worker";
import type { Operation, Subscription } from "effection";
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
 * Handler function for worker-as-principal mode.
 * Receives init data and context, returns tool result.
 */
export type WorkerPrincipalHandler<T = unknown> = (
  initData: WorkerInitData,
  ctx: WorkerToolContext
) => Operation<T>;

/**
 * Handler function for worker-as-operative mode.
 * Receives a request and returns a response.
 */
export type WorkerOperativeHandler = (
  request: WorkerRequest
) => Operation<WorkerResponse>;

/**
 * @deprecated Use `WorkerPrincipalHandler` instead.
 */
export type ToolWorkerHandler<T = unknown> = WorkerPrincipalHandler<T>;

// =============================================================================
// WORKER AS PRINCIPAL
// =============================================================================

/**
 * Run a worker as principal (sends requests to host).
 *
 * In this configuration:
 * - Worker acts as principal (sends sample/elicit requests)
 * - Host acts as operative (handles requests, returns responses)
 *
 * The handler receives:
 * - initData: The initialization data passed from the host
 * - ctx: A WorkerToolContext for sampling, eliciting, logging, and progress
 *
 * This function sets up bidirectional communication using @effectionx/worker:
 * - Tool sends requests (sample/elicit) via send.stream()
 * - Host sends progress via ctx.progress() (received as subscription values)
 * - Host returns response (received as subscription return value)
 *
 * @param handler - Function that executes the tool and returns its result
 */
export async function runWorkerPrincipal<T = unknown>(
  handler: WorkerPrincipalHandler<T>
): Promise<void> {
  // Type parameters for workerMain:
  // TSend = never (host doesn't send requests to worker in this model)
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
       * Send a request to the host and wait for response.
       * Consumes any progress updates while waiting.
       */
      function* sendRequestToHost<TReq extends WorkerRequest, TRes extends WorkerResponse>(
        request: TReq,
        onProgress?: (progress: WorkerProgressMessage) => void
      ): Operation<TRes> {
        // Use send.stream to get a subscription that yields progress and returns response
        const subscription: Subscription<WorkerProgressMessage, WorkerResponse> = 
          yield* send.stream<WorkerProgressMessage>(request);

        // Consume progress updates until we get the final response
        let next = yield* subscription.next();
        while (!next.done) {
          // Call progress callback if provided
          if (onProgress) {
            onProgress(next.value);
          }
          next = yield* subscription.next();
        }

        // Return the final response
        return next.value as TRes;
      }

      /**
       * Create the tool context for the handler.
       */
      const ctx: WorkerToolContext = {
        *sample(options): Operation<WorkerSampleResponse> {
          const id = generateRequestId();
          const request: WorkerSampleRequest = {
            id,
            type: "sample",
            messages: options.messages,
            ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
            ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
            ...(options.modelPreferences !== undefined && { modelPreferences: options.modelPreferences }),
            ...(options.tools !== undefined && { tools: options.tools }),
            ...(options.toolChoice !== undefined && { toolChoice: options.toolChoice }),
            ...(options.schema !== undefined && { schema: options.schema }),
          };

          return yield* sendRequestToHost<WorkerSampleRequest, WorkerSampleResponse>(request);
        },

        *elicit<TContent>(
          key: string,
          options: { message: string; schema: Record<string, unknown> }
        ): Operation<WorkerElicitResponse & { content?: TContent }> {
          const id = generateRequestId();
          const request: WorkerElicitRequest = {
            id,
            type: "elicit",
            key,
            message: options.message,
            schema: options.schema,
          };

          return yield* sendRequestToHost<WorkerElicitRequest, WorkerElicitResponse>(request) as Operation<
            WorkerElicitResponse & { content?: TContent }
          >;
        },

        // Progress is now sent FROM host TO worker, so this becomes a no-op log
        // The worker can still call this for logging purposes, but it won't
        // affect the host's progress tracking
        progress(message: string, progressValue?: number): void {
          // Log progress locally for debugging
          console.log(`[Worker Progress] ${message}${progressValue !== undefined ? ` (${progressValue * 100}%)` : ''}`);
        },

        log(level: WorkerLogMessage["level"], message: string): void {
          // Log locally - in future could be sent via a dedicated log channel
          const logFn = level === "error" ? console.error 
            : level === "warning" ? console.warn 
            : level === "debug" ? console.debug 
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
    }
  );
}

// =============================================================================
// WORKER AS OPERATIVE
// =============================================================================

/**
 * Run a worker as operative (handles requests from host).
 *
 * In this configuration:
 * - Host acts as principal (sends requests)
 * - Worker acts as operative (handles requests, returns responses)
 *
 * This is useful for stateless request handling where each request is independent.
 *
 * @param requestHandler - Function that handles incoming requests from the host
 */
export async function runWorkerOperative(
  requestHandler: WorkerOperativeHandler
): Promise<void> {
  await workerMain<WorkerRequest, WorkerResponse, WorkerResult<void>, WorkerInitData>(
    function* ({ messages }) {
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
    }
  );
}

// =============================================================================
// DEPRECATED ALIASES
// =============================================================================

/**
 * @deprecated Use `runWorkerPrincipal` instead. The worker sends requests
 * to the host, making it the principal (not just a "tool worker").
 */
export const runToolWorker = runWorkerPrincipal;

/**
 * @deprecated Use `runWorkerOperative` instead.
 */
export const runRequestHandler = runWorkerOperative;
