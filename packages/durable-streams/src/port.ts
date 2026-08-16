import type { Operation } from "effection";
import { definePort, type PortFacade } from "@sweatpants/foundation/port";
import type {
  CreateSessionOptions,
  SessionEntry,
  SessionHandle,
  SessionRegistry,
  SessionRegistryStore,
  TokenBuffer,
  TokenBufferStore,
} from "./types.ts";

export class DurableStreamsStoreUnavailable extends Error {
  readonly code = "durable_streams_store_unavailable";
  constructor(what: string) {
    super(
      `${what} not configured. Call setupDurableStreams() or install a ${what} ` +
        "driver in scope before use.",
    );
    this.name = "DurableStreamsStoreUnavailable";
  }
}

/**
 * Token buffer storage as a port.
 *
 * Declared over `unknown` tokens: storage mechanics do not depend on the token
 * type. The intentional type erasure is centralized in named installation and
 * restoration helpers below rather than repeated at call sites.
 */
export const TokenBufferStorePort = definePort<TokenBufferStore<unknown>>(
  "durable-streams-token-buffer-store",
  {
    *create(_id: string): Operation<TokenBuffer<unknown>> {
      throw new DurableStreamsStoreUnavailable("TokenBufferStore");
    },
    *get(_id: string): Operation<TokenBuffer<unknown> | null> {
      throw new DurableStreamsStoreUnavailable("TokenBufferStore");
    },
    *delete(_id: string): Operation<void> {
      throw new DurableStreamsStoreUnavailable("TokenBufferStore");
    },
  },
);

/** Session refcount bookkeeping as a port. */
export const SessionRegistryStorePort = definePort<SessionRegistryStore>(
  "durable-streams-session-registry-store",
  {
    *get(_sessionId: string): Operation<SessionEntry | null> {
      throw new DurableStreamsStoreUnavailable("SessionRegistryStore");
    },
    *set(_sessionId: string, _entry: SessionEntry): Operation<void> {
      throw new DurableStreamsStoreUnavailable("SessionRegistryStore");
    },
    *delete(_sessionId: string): Operation<void> {
      throw new DurableStreamsStoreUnavailable("SessionRegistryStore");
    },
    *updateRefCount(_sessionId: string, _delta: number): Operation<number> {
      throw new DurableStreamsStoreUnavailable("SessionRegistryStore");
    },
  },
);

/** Session lifecycle as a port. */
export const SessionRegistryPort = definePort<SessionRegistry<unknown>>(
  "durable-streams-session-registry",
  {
    *acquire(
      _sessionId: string,
      _options?: CreateSessionOptions<unknown>,
    ): Operation<SessionHandle<unknown>> {
      throw new DurableStreamsStoreUnavailable("SessionRegistry");
    },
    *release(_sessionId: string): Operation<void> {
      throw new DurableStreamsStoreUnavailable("SessionRegistry");
    },
  },
);

type OpaqueTokenBufferStore = TokenBufferStore<unknown>;
type OpaqueSessionRegistry = SessionRegistry<unknown>;

/**
 * Token storage is intentionally type-erased at its one shared port. The
 * implementation never inspects token values; this is the sole type-level
 * erasure for installation.
 */
function eraseTokenBufferStore<T>(store: TokenBufferStore<T>): OpaqueTokenBufferStore {
  return store as unknown as OpaqueTokenBufferStore;
}

/** Restore the caller's token type at the typed facade boundary. */
function restoreTokenBufferStore<T>(store: OpaqueTokenBufferStore): TokenBufferStore<T> {
  return store as unknown as TokenBufferStore<T>;
}

/** Session lifecycle is token-parametric and uses the same shared erasure. */
function eraseSessionRegistry<T>(registry: SessionRegistry<T>): OpaqueSessionRegistry {
  return registry as unknown as OpaqueSessionRegistry;
}

/** Restore the caller's token type at the typed facade boundary. */
function restoreSessionRegistry<T>(registry: OpaqueSessionRegistry): SessionRegistry<T> {
  return registry as unknown as SessionRegistry<T>;
}

export function installTokenBufferStore<T>(store: TokenBufferStore<T>): Operation<void> {
  return TokenBufferStorePort.installDriver(eraseTokenBufferStore(store));
}

export function installSessionRegistryStore(store: SessionRegistryStore): Operation<void> {
  return SessionRegistryStorePort.installDriver(store);
}

export function installSessionRegistry<T>(registry: SessionRegistry<T>): Operation<void> {
  return SessionRegistryPort.installDriver(eraseSessionRegistry(registry));
}

/** Typed token buffer store facade for the current Effection scope. */
export function* useTokenBufferStore<T>(): Operation<TokenBufferStore<T>> {
  return restoreTokenBufferStore(yield* TokenBufferStorePort.use());
}

/** Session refcount store facade for the current Effection scope. */
export function* useSessionRegistryStore(): Operation<PortFacade<SessionRegistryStore>> {
  return yield* SessionRegistryStorePort.use();
}

/** Typed session registry facade for the current Effection scope. */
export function* useSessionRegistry<T>(): Operation<SessionRegistry<T>> {
  return restoreSessionRegistry(yield* SessionRegistryPort.use());
}
