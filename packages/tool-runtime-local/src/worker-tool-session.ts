/**
 * Worker-based Tool Session
 *
 * Adapts @sweatpants/agent-sdk's worker transport to the ToolSession interface.
 * This allows the existing MCP handler infrastructure to work with tools
 * running in isolated worker threads.
 *
 * ## Architecture
 *
 * ```
 * MCP Handler
 *   │
 *   │ ToolSession interface
 *   ▼
 * WorkerToolSession (this module)
 *   │
 *   │ @effectionx/worker via @sweatpants/agent-sdk
 *   ▼
 * Worker (running tool generator via runWorker)
 * ```
 *
 * ## Communication Model
 *
 * Uses @sweatpants/agent-sdk's createWorkerPrincipal which handles:
 * - Worker lifecycle (spawn, cleanup on scope exit)
 * - Bidirectional communication (worker sends requests, host responds)
 * - Final result collection
 *
 * Event-log semantics (LSN, status derivation, replay, settlement) come from
 * the shared `createToolSessionEventLog` kernel in @sweatpants/tool-session.
 *
 * @packageDocumentation
 */

import { type Operation, type Stream, type Queue, resource, spawn } from "effection";
import {
  createWorkerPrincipal,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from "@sweatpants/agent-sdk/transport/worker";
import type { ToolSession, ToolSessionStatus, ToolSessionEvent } from "@sweatpants/tool-session";
import type { ElicitExchangeCompletion, SampleExchangeCompletion } from "@sweatpants/agent-sdk";
import { createToolSessionEventLog, isTerminalToolSessionStatus } from "@sweatpants/tool-session";
import type { McpWorkerInitData } from "./worker-types.ts";
import { WorkerSessionStateContext, type WorkerSessionState } from "./worker-session-context.ts";
import { WorkerSessionApi } from "./worker-session-api.ts";

// =============================================================================
// WORKER TOOL SESSION
// =============================================================================

/**
 * Options for creating a worker tool session.
 */
export interface WorkerToolSessionOptions {
  /** Session ID */
  sessionId: string;
  /** Tool name */
  toolName: string;
  /** Tool parameters */
  params: unknown;
  /** URL to the worker script */
  workerUrl: string | URL;
  /** Extra execArgv for the worker thread (e.g., ['--import', 'tsx'] for TypeScript support) */
  execArgv?: string[];
}

/**
 * Create a ToolSession backed by a web worker.
 *
 * This resource:
 * 1. Spawns a worker with the tool to execute
 * 2. Handles requests from the worker via WorkerSessionApi operations
 * 3. Exposes the ToolSession interface for the host to interact
 *
 * @param options - Session configuration
 * @returns A ToolSession resource
 */
export function createWorkerToolSession(options: WorkerToolSessionOptions): Operation<ToolSession> {
  return resource<ToolSession>(function* (provide) {
    const { sessionId, toolName, params, workerUrl, execArgv } = options;

    const log = createToolSessionEventLog();
    let cancellationRequested = false;
    let cancellationReason: string | undefined;

    const pendingSamples = new Map<string, Queue<SampleExchangeCompletion, void>>();
    const pendingElicits = new Map<string, Queue<ElicitExchangeCompletion<unknown>, void>>();

    function closePendingResponses(): void {
      for (const queue of pendingElicits.values()) {
        queue.close(undefined);
      }
      for (const queue of pendingSamples.values()) {
        queue.close(undefined);
      }
      pendingElicits.clear();
      pendingSamples.clear();
    }

    const sessionState: WorkerSessionState = {
      pendingElicitChannels: pendingElicits,
      pendingSampleChannels: pendingSamples,
      *emitEvent(event) {
        log.append(event);
      },
      nextLsn: () => log.peekNextLsn(),
      setStatus: (nextStatus: ToolSessionStatus) => {
        log.setStatus(nextStatus);
      },
    };

    yield* WorkerSessionStateContext.set(sessionState);

    // Build init data for the worker
    const initData: McpWorkerInitData = {
      toolName,
      params,
      sessionId,
    };

    // Create the worker using core's createWorkerPrincipal
    // Note: We use WorkerSessionStateContext.with() to ensure the context is available
    // in the spawned request handler scope inside createWorkerPrincipal
    const { result: workerResult } = yield* createWorkerPrincipal<unknown, McpWorkerInitData>({
      workerUrl,
      initData,
      ...(execArgv && execArgv.length > 0 ? { execArgv } : {}),
      requestHandler: function* (request: WorkerRequest): Operation<WorkerResponse> {
        // Re-establish context for this handler scope
        return yield* WorkerSessionStateContext.with(sessionState, function* () {
          if (request.type === "sample") {
            return yield* WorkerSessionApi.operations.handleSampleRequest(request);
          }

          if (request.type === "elicit") {
            return yield* WorkerSessionApi.operations.handleElicitRequest(request);
          }

          throw new Error(`Unknown request type: ${(request as WorkerRequest).type}`);
        });
      },
    });

    // Mark as running
    log.setStatus("running");

    // Spawn a task to wait for the worker result
    yield* spawn(function* () {
      try {
        const result: WorkerResult<unknown> = yield* workerResult;

        if (cancellationRequested) {
          log.append({
            type: "cancelled",
            ...(cancellationReason !== undefined ? { reason: cancellationReason } : {}),
          });
        } else if (result.type === "success") {
          log.append({ type: "result", result: result.value });
        } else if (result.type === "error") {
          log.append({
            type: "error",
            name: result.error.name,
            message: result.error.message,
            ...(result.error.stack !== undefined && { stack: result.error.stack }),
          });
        } else if (result.type === "cancelled") {
          log.append({
            type: "cancelled",
            ...(result.reason !== undefined && { reason: result.reason }),
          });
        }
      } catch (error) {
        const err = error as Error;
        log.append({
          type: "error",
          name: err.name,
          message: err.message,
          ...(err.stack !== undefined && { stack: err.stack }),
        });
      } finally {
        log.close();
      }
    });

    // Create the session interface
    const session: ToolSession = {
      id: sessionId,
      toolName,

      *status(): Operation<ToolSessionStatus> {
        return log.status;
      },

      settled: () => log.settled(),

      notices: {
        events(afterLSN?: number): Stream<ToolSessionEvent, void> {
          return log.events(afterLSN);
        },
      },

      *respondToElicit(
        elicitId: string,
        response: ElicitExchangeCompletion<unknown>,
      ): Operation<void> {
        yield* WorkerSessionStateContext.with(sessionState, function* () {
          yield* WorkerSessionApi.operations.respondToElicit(elicitId, response);
        });
      },

      *respondToSample(sampleId: string, response: SampleExchangeCompletion): Operation<void> {
        yield* WorkerSessionStateContext.with(sessionState, function* () {
          yield* WorkerSessionApi.operations.respondToSample(sampleId, response);
        });
      },

      *cancel(reason?: string): Operation<void> {
        if (isTerminalToolSessionStatus(log.status) || cancellationRequested) {
          return;
        }
        cancellationRequested = true;
        cancellationReason = reason;
        // Unblock the worker-side request handler. Terminal `cancelled` is
        // published only after workerResult settles, so registry ownership
        // cannot outrun actual worker termination.
        closePendingResponses();
      },
    };

    try {
      yield* provide(session);
    } finally {
      closePendingResponses();
      log.close();
    }
  });
}
