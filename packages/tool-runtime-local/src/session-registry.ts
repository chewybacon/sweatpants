/**
 * Tool Session Registry Implementation
 *
 * Manages tool session lifecycle with reference counting for automatic cleanup.
 * Sessions represent a durable tool execution that survives HTTP request boundaries.
 *
 * Key behaviors:
 * - create() creates a new session and starts tool execution
 * - acquire() returns existing session, increments refCount
 * - release() decrements refCount, triggers cleanup when refCount=0 AND complete
 * - Tool execution runs in the registry owner scope, surviving request teardown
 * - Reconnection works by acquiring the same sessionId while tool is still running
 *
 * @packageDocumentation
 */
import { type Operation, type Task, resource, createQueue, spawn, useScope } from "effection";
import type {
  ToolSessionRegistry,
  ToolSessionStore,
  ToolSession,
  ToolSessionEntry,
  ToolSessionOptions,
  ToolSessionStatus,
  ElicitsMap,
} from "@sweatpants/tool-session";
import { isExecutableToolContract, type ToolContract } from "@sweatpants/agent-sdk";
import { installToolSessionStore, ToolSessionStorePort } from "./session-store-port.ts";
import { validateToolParameters } from "@sweatpants/tool-session/tool-parameters";
import { createToolSession } from "./tool-session.ts";
import { createWorkerToolSession } from "./worker-tool-session.ts";

const TOOL_SESSION_REGISTRY_EXECUTION_MODE = Symbol.for(
  "@sweatpants/tool-runtime-local/tool-session-registry-execution-mode",
);

type ToolSessionRegistryExecutionMode = "inline" | "worker";
type ToolSessionRegistryWithExecutionMode = ToolSessionRegistry & {
  [TOOL_SESSION_REGISTRY_EXECUTION_MODE]: ToolSessionRegistryExecutionMode;
};

export function isWorkerBackedToolSessionRegistry(registry: ToolSessionRegistry): boolean {
  return (
    (registry as Partial<ToolSessionRegistryWithExecutionMode>)[
      TOOL_SESSION_REGISTRY_EXECUTION_MODE
    ] === "worker"
  );
}

function resolveWorkerUrl(workerUrl: string | URL, isDev?: boolean): string | URL {
  if (!isDev) {
    return workerUrl;
  }

  if (workerUrl instanceof URL) {
    if (workerUrl.protocol === "file:") {
      return workerUrl;
    }
    const cacheBusted = new URL(workerUrl.toString());
    cacheBusted.searchParams.set("t", Date.now().toString());
    return cacheBusted;
  }

  if (/^https?:\/\//.test(workerUrl)) {
    const cacheBusted = new URL(workerUrl);
    cacheBusted.searchParams.set("t", Date.now().toString());
    return cacheBusted;
  }

  return workerUrl;
}

// =============================================================================
// SESSION REGISTRY IMPLEMENTATION
// =============================================================================

/**
 * Options for creating a tool session registry.
 */
export interface ToolSessionRegistryOptions {
  /**
   * Default timeout for sessions in milliseconds.
   * @default undefined (no timeout)
   */
  defaultTimeout?: number;

  /**
   * Worker mode configuration (optional).
   * When set, tool sessions run in worker threads via createWorkerToolSession.
   */
  worker?: {
    workerUrl: string | URL;
    isDev?: boolean;
    /** Extra execArgv for worker threads (e.g., ['--import', 'tsx'] for TypeScript support in dev) */
    execArgv?: string[];
  };
}

/**
 * Creates a ToolSessionRegistry for managing tool session lifecycles.
 *
 * The registry manages tool execution and provides reference counting
 * for automatic cleanup when sessions are no longer needed.
 *
 * IMPORTANT: Session creation uses the registry owner scope to ensure the tool
 * session survives HTTP request boundaries even when the chat-engine scope for a
 * single request exits immediately after emitting an elicitation event.
 *
 * @param store - Store for tracking session entries
 * @param options - Registry configuration options
 * @returns ToolSessionRegistry resource
 */
function* waitForSettlement(session: ToolSession): Operation<ToolSessionStatus> {
  const current = yield* session.status();
  if (current === "completed" || current === "failed" || current === "cancelled") {
    return current;
  }
  if (!session.settled) {
    throw new Error("ToolSession must provide event-driven settled()");
  }
  return yield* session.settled();
}

export function createToolSessionRegistry(
  store: ToolSessionStore,
  options: ToolSessionRegistryOptions,
): Operation<ToolSessionRegistry> {
  return resource<ToolSessionRegistry>(function* (provide) {
    const { defaultTimeout, worker } = options;
    const ownerScope = yield* useScope();
    // The supplied adapter becomes this scope's innermost driver, so every
    // store call below is interceptable by middleware installed in an ancestor
    // scope without widening the store type for observation.
    yield* installToolSessionStore(store);
    // SCOPE-CROSSING (ownership): the registry is a resource owned by this scope,
    // but its methods are called from arbitrary request scopes. The store is a
    // property of the registry, not of whoever calls it, so it is resolved once
    // here rather than per call. The store driver may itself be remote; that
    // boundary is inside the driver, not across this handle. See ADR-004.
    const store_ = ToolSessionStorePort.bind(ownerScope);

    // Tool sessions attach to the registry/application owner scope rather than
    // the request that invoked create(), so they survive HTTP park/resume while
    // retaining normal structured teardown.
    const activeSessions = new Map<string, ToolSession>();
    // Deferred cleanup is owned by the registry scope, never by whichever
    // request scope happened to call release(). A request that exits while a
    // session is still settling must not silently cancel its cleanup.
    const cleanupTasks = new Set<Task<void>>();

    function superviseCleanup(sessionId: string, session: ToolSession): void {
      const task: Task<void> = ownerScope.run(function* () {
        yield* waitForSettlement(session);
        const currentEntry = yield* store_.get(sessionId);
        if (currentEntry && currentEntry.refCount === 0) {
          yield* cleanup(sessionId);
        }
      });
      cleanupTasks.add(task);
      void Promise.resolve(task)
        .catch(() => undefined)
        .finally(() => {
          cleanupTasks.delete(task);
        });
    }

    /**
     * Internal cleanup helper - removes session from store and active map.
     */
    function* cleanup(sessionId: string): Operation<void> {
      yield* store_.delete(sessionId);
      activeSessions.delete(sessionId);
    }

    const registry: ToolSessionRegistryWithExecutionMode = {
      [TOOL_SESSION_REGISTRY_EXECUTION_MODE]: worker ? "worker" : "inline",
      *create<TParams, _TInteraction, _TClient, TResult, TElicits extends ElicitsMap>(
        tool: ToolContract<string, TParams, TResult, TElicits>,
        params: TParams,
        sessionOptions?: ToolSessionOptions,
      ): Operation<ToolSession<TResult>> {
        // F4: worker mode executes in the worker identified by workerUrl and
        // needs only the portable contract. Inline mode runs the closure in
        // this process, so a metadata-only projection is rejected explicitly
        // instead of failing deep inside session start.
        const inlineTool = isExecutableToolContract(tool) ? tool : null;
        if (!worker && !inlineTool) {
          throw new Error(
            `Tool "${tool.name}" is a metadata-only contract projection; inline execution requires the full ToolDefinition (or configure worker mode)`,
          );
        }
        const mergedOptions: ToolSessionOptions = {
          ...sessionOptions,
          ...(defaultTimeout !== undefined && { timeout: defaultTimeout }),
        };

        const validatedParams = validateToolParameters<TParams>({
          schema: tool.parameters,
          params,
          toolName: tool.name,
          callId: mergedOptions.sessionId ?? tool.name,
        });

        // Use a queue to receive the session from the spawned background task.
        // This handoff crosses detached scopes, so it must be buffered: an
        // unbuffered Channel can deadlock if the background task sends before
        // the caller has subscribed.
        const sessionQueue = createQueue<ToolSession<TResult>, void>();

        // CRITICAL: Run tool sessions in the captured registry/application
        // scope. The durable chat handler can end the current request scope
        // immediately after emitting an elicitation; the owner scope survives
        // that boundary and is cancelled exactly once with the application.
        const backgroundTask = ownerScope.run(function* () {
          const resolvedWorkerUrl = worker
            ? resolveWorkerUrl(worker.workerUrl, worker.isDev)
            : undefined;
          const session = (
            worker
              ? yield* createWorkerToolSession({
                  sessionId: mergedOptions.sessionId ?? tool.name,
                  toolName: tool.name,
                  params: validatedParams,
                  workerUrl: resolvedWorkerUrl ?? worker.workerUrl,
                  ...(worker.execArgv && worker.execArgv.length > 0
                    ? { execArgv: worker.execArgv }
                    : {}),
                })
              : yield* createToolSession(inlineTool!, validatedParams, mergedOptions)
          ) as ToolSession<TResult>;

          // Send session back to caller
          sessionQueue.add(session);

          // Keep this scope alive without timer polling until terminal state.
          yield* waitForSettlement(session);
        });
        void backgroundTask.catch(() => undefined);

        // Receive the session from the spawned task
        const result = yield* sessionQueue.next();
        if (result.done) {
          throw new Error("Session channel closed unexpectedly");
        }
        const session = result.value;

        // Store in active sessions map
        activeSessions.set(session.id, session as ToolSession);

        // Create entry with initial refCount of 1
        const entry: ToolSessionEntry<TResult> = {
          session: session as ToolSession<TResult>,
          refCount: 1,
          createdAt: Date.now(),
          status: "initializing",
        };
        yield* store_.set(session.id, entry as ToolSessionEntry);

        // Event-driven terminal status monitor; do not call status() concurrently
        // with a newly returned worker session. Immediate tools can settle while
        // the caller is already consuming events, so settled() is the single
        // startup-safe synchronization point.
        yield* spawn(function* () {
          const status = session.settled
            ? yield* session.settled()
            : yield* waitForSettlement(session);
          if (yield* store_.get(session.id)) {
            yield* store_.updateStatus(session.id, status);
          }
        });

        return session;
      },

      *get(sessionId: string): Operation<ToolSession | null> {
        const entry = yield* store_.get(sessionId);
        if (!entry) {
          return null;
        }

        // Return from active sessions if available
        const active = activeSessions.get(sessionId);
        if (active) {
          return active;
        }

        // Entry exists but session not in active map - session may have been
        // orphaned (e.g., server restart). Return the entry's session reference.
        return entry.session;
      },

      *acquire(sessionId: string): Operation<ToolSession> {
        const entry = yield* store_.get(sessionId);
        if (!entry) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        // Increment refCount
        yield* store_.updateRefCount(sessionId, 1);

        // Return from active sessions if available
        const active = activeSessions.get(sessionId);
        if (active) {
          return active;
        }

        // Return the entry's session reference
        return entry.session;
      },

      *release(sessionId: string): Operation<void> {
        const entry = yield* store_.get(sessionId);
        if (!entry) {
          // Session already cleaned up, nothing to do
          return;
        }

        // Decrement refCount
        const newRefCount = yield* store_.updateRefCount(sessionId, -1);

        if (newRefCount === 0) {
          // Check if session is complete
          const session = activeSessions.get(sessionId) ?? entry.session;
          const status = yield* session.status();

          const isComplete =
            status === "completed" || status === "failed" || status === "cancelled";

          if (isComplete) {
            // Session complete and no clients - cleanup immediately
            yield* cleanup(sessionId);
          } else {
            // Session still running - registry-owned, event-driven cleanup.
            superviseCleanup(sessionId, session);
          }
        }
      },
    };

    try {
      yield* provide(registry);
    } finally {
      // Structured teardown: outstanding cleanup waiters are halted here rather
      // than leaking past the registry lifetime.
      for (const task of [...cleanupTasks]) {
        yield* task.halt();
      }
      cleanupTasks.clear();
      activeSessions.clear();
    }
  });
}
