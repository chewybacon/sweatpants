/**
 * Worker-based Tool Session
 *
 * Adapts @sweatpants/core's worker transport to the ToolSession interface.
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
 *   │ @effectionx/worker via @sweatpants/core
 *   ▼
 * Worker (running tool generator via runWorker)
 * ```
 *
 * ## Communication Model
 *
 * Uses @sweatpants/core's createWorkerPrincipal which handles:
 * - Worker lifecycle (spawn, cleanup on scope exit)
 * - Bidirectional communication (worker sends requests, host responds)
 * - Final result collection
 *
 * @packageDocumentation
 */

import {
  type Operation,
  type Stream,
  type Subscription,
  type Queue,
  resource,
  action,
  spawn,
} from "effection";
import {
  createWorkerPrincipal,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from "@sweatpants/core/transport/worker";
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  WireSampleResult,
} from "@sweatpants/framework/chat/mcp-tools";
import type { WireElicitResult } from "@sweatpants/framework/chat/mcp-tools";
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
function isTerminalStatus(status: ToolSessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function createWorkerToolSession(options: WorkerToolSessionOptions): Operation<ToolSession> {
  return resource<ToolSession>(function* (provide) {
    const { sessionId, toolName, params, workerUrl, execArgv } = options;

    // State
    let status: ToolSessionStatus = "initializing";
    let cancellationRequested = false;
    let cancellationReason: string | undefined;
    let lsn = 0;
    const eventBuffer: ToolSessionEvent[] = [];
    const settledWaiters = new Set<(status: ToolSessionStatus) => void>();
    const notifySettled = (terminalStatus: ToolSessionStatus): void => {
      for (const resolve of settledWaiters) resolve(terminalStatus);
      settledWaiters.clear();
    };

    // Event-buffer waiters provide replay plus non-blocking publication. A
    // parked session may have no live subscriber when cancellation arrives;
    // terminal event publication must still complete synchronously.
    const eventWaiters = new Set<() => void>();
    let eventStreamClosed = false;
    const notifyEventWaiters = (): void => {
      for (const resolve of eventWaiters) resolve();
      eventWaiters.clear();
    };

    const pendingSamples = new Map<string, Queue<WireSampleResult, void>>();
    const pendingElicits = new Map<string, Queue<WireElicitResult<unknown>, void>>();

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

    function nextLsn(): number {
      lsn += 1;
      return lsn;
    }

    // Helper to emit events
    // Using a more permissive input type to avoid TypeScript's excess property checking issues
    // with discriminated unions - the 'type' field discriminates at runtime
    function* emitEvent(
      event: { type: ToolSessionEvent["type"] } & Record<string, unknown>,
    ): Operation<void> {
      const fullEvent: ToolSessionEvent = {
        ...event,
        lsn: nextLsn(),
        timestamp: Date.now(),
      } as ToolSessionEvent;

      eventBuffer.push(fullEvent);

      // Update status based on event type
      switch (fullEvent.type) {
        case "sample_request":
          status = "awaiting_sample";
          break;
        case "elicit_request":
          status = "awaiting_elicit";
          break;
        case "result":
          status = "completed";
          notifySettled(status);
          break;
        case "error":
          status = "failed";
          notifySettled(status);
          break;
        case "cancelled":
          status = "cancelled";
          notifySettled(status);
          break;
        case "progress":
        case "log":
          if (status === "initializing") {
            status = "running";
          }
          break;
      }

      notifyEventWaiters();
    }

    const sessionState: WorkerSessionState = {
      pendingElicitChannels: pendingElicits,
      pendingSampleChannels: pendingSamples,
      emitEvent,
      nextLsn,
      setStatus: (nextStatus: ToolSessionStatus) => {
        status = nextStatus;
        if (isTerminalStatus(status)) notifySettled(status);
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
    status = "running";

    // Spawn a task to wait for the worker result
    yield* spawn(function* () {
      try {
        const result: WorkerResult<unknown> = yield* workerResult;

        if (cancellationRequested) {
          yield* emitEvent({
            type: "cancelled",
            ...(cancellationReason !== undefined ? { reason: cancellationReason } : {}),
          });
        } else if (result.type === "success") {
          yield* emitEvent({
            type: "result",
            result: result.value,
          });
        } else if (result.type === "error") {
          yield* emitEvent({
            type: "error",
            name: result.error.name,
            message: result.error.message,
            ...(result.error.stack !== undefined && { stack: result.error.stack }),
          });
        } else if (result.type === "cancelled") {
          yield* emitEvent({
            type: "cancelled",
            ...(result.reason !== undefined && { reason: result.reason }),
          });
        }
      } catch (error) {
        const err = error as Error;
        yield* emitEvent({
          type: "error",
          name: err.name,
          message: err.message,
          ...(err.stack !== undefined && { stack: err.stack }),
        });
      } finally {
        eventStreamClosed = true;
        notifyEventWaiters();
      }
    });

    // Create the session interface
    const session: ToolSession = {
      id: sessionId,
      toolName,

      *status(): Operation<ToolSessionStatus> {
        return status;
      },

      *settled(): Operation<ToolSessionStatus> {
        return yield* action<ToolSessionStatus>((resolve) => {
          if (isTerminalStatus(status)) resolve(status);
          else settledWaiters.add(resolve);
          return () => settledWaiters.delete(resolve);
        });
      },

      events(afterLSN?: number): Stream<ToolSessionEvent, void> {
        return resource<Subscription<ToolSessionEvent, void>>(function* (provideStream) {
          let bufferedIndex = afterLSN ?? 0;
          yield* provideStream({
            *next(): Operation<IteratorResult<ToolSessionEvent, void>> {
              while (bufferedIndex >= eventBuffer.length) {
                if (eventStreamClosed) {
                  return { done: true, value: undefined };
                }
                yield* action<void>((resolve) => {
                  eventWaiters.add(resolve);
                  return () => eventWaiters.delete(resolve);
                });
              }
              return { done: false, value: eventBuffer[bufferedIndex++]! };
            },
          });
        });
      },

      *respondToElicit(elicitId: string, response: WireElicitResult<unknown>): Operation<void> {
        yield* WorkerSessionStateContext.with(sessionState, function* () {
          yield* WorkerSessionApi.operations.respondToElicit(elicitId, response);
        });
      },

      *respondToSample(sampleId: string, response: WireSampleResult): Operation<void> {
        yield* WorkerSessionStateContext.with(sessionState, function* () {
          yield* WorkerSessionApi.operations.respondToSample(sampleId, response);
        });
      },

      *cancel(reason?: string): Operation<void> {
        if (isTerminalStatus(status) || cancellationRequested) {
          return;
        }
        cancellationRequested = true;
        cancellationReason = reason;
        // Unblock the worker-side request handler. Terminal `cancelled` is
        // published only after workerResult settles, so registry ownership
        // cannot outrun actual worker termination.
        closePendingResponses();
      },

      *emitWakeUp(): Operation<void> {
        // Worker sessions don't need wake-up events - they use message passing
        // between the host and worker thread, which has its own scheduling.
        // This is a no-op for worker sessions.
      },
    };

    try {
      yield* provide(session);
    } finally {
      closePendingResponses();
      eventStreamClosed = true;
      notifyEventWaiters();
    }
  });
}
