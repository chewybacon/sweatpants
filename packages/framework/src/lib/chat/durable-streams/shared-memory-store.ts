/**
 * Shared Memory Store Implementations
 *
 * Similar to in-memory-store.ts but designed to work across Effection scopes.
 * The backing storage (Maps, EventEmitters) is passed in from outside,
 * allowing state to persist across HTTP request scopes.
 *
 * Key difference from in-memory-store.ts:
 * - Storage is externalized (passed in, not created internally)
 * - Uses EventEmitter for cross-scope notifications instead of Effection Signal
 * - Buffers and entries survive scope destruction
 *
 * Usage:
 * ```typescript
 * // At server startup (outside any Effection scope)
 * const sharedStorage = createSharedStorage<string>()
 *
 * // In each request handler
 * const bufferStore = createSharedBufferStore(sharedStorage)
 * const registryStore = createSharedRegistryStore(sharedStorage)
 * yield* setupDurableStreams({ bufferStore, registryStore })
 * ```
 */
import { call, type Operation } from "effection";
import { EventEmitter } from "events";
import type {
  TokenBuffer,
  TokenBufferStore,
  SessionRegistryStore,
  SessionEntry,
  SessionStatus,
  TokenBufferWriter,
} from "@sweatpants/durable-streams";
import { StaleTokenWriterError } from "@sweatpants/durable-streams";
import type { Logger } from "../../logger/index.ts";

// Use a simple console-based logger at module level
// (pino with transport can hang in certain environments like Vite SSR)
function createSimpleLogger(prefix: string): Logger {
  return {
    trace: (obj: object | string, msg?: string) => {
      if (process.env["DEBUG_DURABLE"]) {
        console.log(
          `[${prefix}:trace]`,
          typeof obj === "string" ? obj : msg,
          typeof obj === "object" ? obj : undefined,
        );
      }
    },
    debug: (obj: object | string, msg?: string) => {
      if (process.env["DEBUG_DURABLE"]) {
        console.log(
          `[${prefix}:debug]`,
          typeof obj === "string" ? obj : msg,
          typeof obj === "object" ? obj : undefined,
        );
      }
    },
    info: (obj: object | string, msg?: string) =>
      console.log(
        `[${prefix}:info]`,
        typeof obj === "string" ? obj : msg,
        typeof obj === "object" ? obj : undefined,
      ),
    warn: (obj: object | string, msg?: string) =>
      console.warn(
        `[${prefix}:warn]`,
        typeof obj === "string" ? obj : msg,
        typeof obj === "object" ? obj : undefined,
      ),
    error: (obj: object | string, msg?: string) =>
      console.error(
        `[${prefix}:error]`,
        typeof obj === "string" ? obj : msg,
        typeof obj === "object" ? obj : undefined,
      ),
    child: (bindings: Record<string, unknown>) =>
      createSimpleLogger(`${prefix}:${Object.values(bindings).join(":")}`),
  };
}

const log: Logger = createSimpleLogger("shared-store");

// =============================================================================
// SHARED STORAGE TYPES
// =============================================================================

/**
 * Internal state for a buffer that can be shared across scopes.
 * This is the "dumb" data that lives outside Effection.
 */
export interface SharedBufferState<T> {
  tokens: T[];
  completed: boolean;
  error: Error | null;
  writerFence?: { ownerId: string; activationEpoch: number };
  /** EventEmitter for cross-scope notifications */
  emitter: EventEmitter;
}

/**
 * Shared storage container that lives outside Effection scopes.
 * Create once at server startup, pass to stores in each request.
 */
export interface SharedStorage<T> {
  /** Buffer states keyed by buffer ID */
  buffers: Map<string, SharedBufferState<T>>;
  /** Session entries keyed by session ID */
  sessions: Map<string, SessionEntry>;
  /** Session status keyed by session ID (mutable, updated by writer tasks) */
  sessionStatus: Map<string, SessionStatus>;
}

/**
 * Create a shared storage container.
 * Call this once at server startup and reuse across all requests.
 *
 * @example
 * ```typescript
 * // server.ts (at startup)
 * const sharedStorage = createSharedStorage<string>()
 *
 * // In request handler
 * app.post('/chat', async (req, res) => {
 *   const bufferStore = createSharedBufferStore(sharedStorage)
 *   // ...
 * })
 * ```
 */
export function createSharedStorage<T>(): SharedStorage<T> {
  return {
    buffers: new Map(),
    sessions: new Map(),
    sessionStatus: new Map(),
  };
}

// =============================================================================
// SHARED TOKEN BUFFER
// =============================================================================

/**
 * Creates a TokenBuffer backed by shared state.
 *
 * Uses EventEmitter for change notifications, which works across
 * Effection scopes (unlike Effection Signal which is scope-bound).
 */
function createSharedBuffer<T>(id: string, state: SharedBufferState<T>): TokenBuffer<T> {
  function assertFence(ownerId: string, activationEpoch: number): void {
    if (
      !state.writerFence ||
      state.writerFence.ownerId !== ownerId ||
      state.writerFence.activationEpoch !== activationEpoch
    ) {
      throw new StaleTokenWriterError();
    }
  }

  function appendTokens(newTokens: T[]): number {
    if (state.completed || state.error) {
      throw new Error("Buffer is closed");
    }
    state.tokens.push(...newTokens);
    state.emitter.emit("change");
    if (state.tokens.length % 50 === 0) {
      log.debug({ bufferId: id, tokenCount: state.tokens.length }, "buffer append progress");
    }
    return state.tokens.length;
  }

  function completeBuffer(): void {
    if (state.completed) {
      return;
    }
    log.debug({ bufferId: id, totalTokens: state.tokens.length }, "buffer complete");
    state.completed = true;
    state.emitter.emit("change");
  }

  function failBuffer(err: Error): void {
    if (state.completed) {
      return;
    }
    log.error({ bufferId: id, error: err.message }, "buffer failed");
    state.completed = true;
    state.error = err.message.length <= 1024 ? err : new Error(err.message.slice(0, 1024));
    state.error.name = err.name;
    state.emitter.emit("change");
  }

  const buffer: TokenBuffer<T> = {
    id,

    *claimWriter(request): Operation<TokenBufferWriter<T>> {
      if (
        !request.ownerId ||
        !Number.isSafeInteger(request.activationEpoch) ||
        request.activationEpoch < 0
      ) {
        throw new Error("Writer owner and nonnegative activation epoch are required");
      }
      if (
        state.writerFence &&
        (request.activationEpoch < state.writerFence.activationEpoch ||
          (request.activationEpoch === state.writerFence.activationEpoch &&
            request.ownerId !== state.writerFence.ownerId))
      ) {
        throw new StaleTokenWriterError();
      }
      state.writerFence = { ...request };
      const fence = { streamId: id, ...request };
      return {
        fence,
        *append(tokens): Operation<number> {
          assertFence(request.ownerId, request.activationEpoch);
          return appendTokens(tokens);
        },
        *complete(): Operation<void> {
          assertFence(request.ownerId, request.activationEpoch);
          completeBuffer();
        },
        *fail(error): Operation<void> {
          assertFence(request.ownerId, request.activationEpoch);
          failBuffer(error);
        },
      };
    },

    *read(afterLSN = 0): Operation<{ tokens: T[]; lsn: number }> {
      return {
        tokens: state.tokens.slice(afterLSN),
        lsn: state.tokens.length,
      };
    },

    *isComplete(): Operation<boolean> {
      return state.completed;
    },

    *getError(): Operation<Error | null> {
      return state.error;
    },

    *waitForChange(afterLSN: number): Operation<void> {
      // If there's already new data or stream is done, return immediately
      if (state.tokens.length > afterLSN || state.completed || state.error) {
        log.debug(
          {
            bufferId: id,
            afterLSN,
            currentLength: state.tokens.length,
            completed: state.completed,
          },
          "waitForChange: immediate return",
        );
        return;
      }

      log.debug({ bufferId: id, afterLSN }, "waitForChange: waiting for notification");
      yield* call(
        () =>
          new Promise<void>((resolve) => {
            const changed = () => resolve();
            state.emitter.once("change", changed);
            // Subscribe before re-checking to close the dropped-wakeup race.
            if (state.tokens.length > afterLSN || state.completed || state.error) {
              state.emitter.off("change", changed);
              resolve();
            }
          }),
      );
      log.debug(
        { bufferId: id, afterLSN, newLength: state.tokens.length },
        "waitForChange: change detected",
      );
    },
  };

  return buffer;
}

// =============================================================================
// SHARED TOKEN BUFFER STORE
// =============================================================================

/**
 * Creates a TokenBufferStore backed by shared storage.
 *
 * Multiple instances can be created from the same SharedStorage,
 * and they will all see the same buffers.
 */
export function createSharedBufferStore<T>(storage: SharedStorage<T>): TokenBufferStore<T> {
  return {
    *create(id: string): Operation<TokenBuffer<T>> {
      log.debug({ bufferId: id }, "bufferStore.create");
      if (storage.buffers.has(id)) {
        throw new Error(`Buffer ${id} already exists`);
      }

      // Create the shared state
      const state: SharedBufferState<T> = {
        tokens: [],
        completed: false,
        error: null,
        emitter: new EventEmitter(),
      };
      storage.buffers.set(id, state);
      log.debug({ bufferId: id }, "buffer created in shared storage");

      // Return a buffer wrapper around the state
      return createSharedBuffer(id, state);
    },

    *get(id: string): Operation<TokenBuffer<T> | null> {
      const state = storage.buffers.get(id);
      if (!state) {
        log.debug({ bufferId: id }, "bufferStore.get: not found");
        return null;
      }
      log.debug({ bufferId: id }, "bufferStore.get: found");
      // Return a buffer wrapper around the existing state
      return createSharedBuffer(id, state);
    },

    *delete(id: string): Operation<void> {
      log.debug({ bufferId: id }, "bufferStore.delete");
      const state = storage.buffers.get(id);
      if (state) {
        // Clean up the emitter
        state.emitter.removeAllListeners();
        storage.buffers.delete(id);
      }
    },
  };
}

// =============================================================================
// SHARED SESSION REGISTRY STORE
// =============================================================================

/**
 * Creates a SessionRegistryStore backed by shared storage.
 *
 * Multiple instances can be created from the same SharedStorage,
 * and they will all see the same session entries.
 */
export function createSharedRegistryStore<T>(storage: SharedStorage<T>): SessionRegistryStore {
  return {
    *get(sessionId: string): Operation<SessionEntry | null> {
      return storage.sessions.get(sessionId) ?? null;
    },

    *set(sessionId: string, entry: SessionEntry): Operation<void> {
      storage.sessions.set(sessionId, entry);
    },

    *delete(sessionId: string): Operation<void> {
      storage.sessions.delete(sessionId);
      storage.sessionStatus.delete(sessionId);
    },

    *updateRefCount(sessionId: string, delta: number): Operation<number> {
      const entry = storage.sessions.get(sessionId);
      if (!entry) {
        throw new Error(`Session ${sessionId} not found`);
      }
      entry.refCount += delta;
      return entry.refCount;
    },
  };
}

// =============================================================================
// CONVENIENCE: SETUP HELPER
// =============================================================================

/**
 * Configuration for shared durable streams.
 */
export interface SharedDurableStreamsConfig<T> {
  storage: SharedStorage<T>;
}

/**
 * Get or create stores from shared storage.
 * Use this in your handler or application setup.
 *
 * @example
 * ```typescript
 * const sharedStorage = createSharedStorage<string>()
 *
 * createDurableChatHandler({
 *   setup: function* () {
 *     const { bufferStore, registryStore } = getSharedStores(sharedStorage)
 *     yield* setupDurableStreams({ bufferStore, registryStore })
 *   }
 * })
 * ```
 */
export function getSharedStores<T>(storage: SharedStorage<T>): {
  bufferStore: TokenBufferStore<T>;
  registryStore: SessionRegistryStore;
} {
  return {
    bufferStore: createSharedBufferStore(storage),
    registryStore: createSharedRegistryStore(storage),
  };
}
