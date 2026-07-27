import { useScope, type Operation } from "effection";
import { definePort } from "@sweatpants/foundation/port";
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
 * type, and the sole cast is confined to the typed binding below rather than
 * repeated at every call site.
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

/**
 * Installs the token buffer store for the calling scope.
 *
 * Tokens are opaque to storage, so the token type is erased at the seam and
 * restored by the typed binding.
 */
export function installTokenBufferStore<T>(store: TokenBufferStore<T>): Operation<void> {
  // SAFETY: the driver only stores and returns buffers it was given; storage
  // mechanics never inspect the token type.
  return TokenBufferStorePort.installDriver(store as TokenBufferStore<unknown>);
}

export function installSessionRegistryStore(store: SessionRegistryStore): Operation<void> {
  return SessionRegistryStorePort.installDriver(store);
}

export function installSessionRegistry<T>(registry: SessionRegistry<T>): Operation<void> {
  // SAFETY: as above; session lifecycle does not depend on the token type.
  return SessionRegistryPort.installDriver(registry as SessionRegistry<unknown>);
}

/**
 * Typed token buffer store bound to the calling scope.
 *
 * The token type is restored here; storage itself never inspected it.
 */
export function* useTokenBufferStore<T>(): Operation<TokenBufferStore<T>> {
  // SAFETY: inverse of the erasure performed by installTokenBufferStore.
  return TokenBufferStorePort.bind(yield* useScope()) as TokenBufferStore<T>;
}

/** Session refcount store bound to the calling scope. */
export function* useSessionRegistryStore(): Operation<SessionRegistryStore> {
  return SessionRegistryStorePort.bind(yield* useScope());
}

/** Typed session registry bound to the calling scope. */
export function* useSessionRegistry<T>(): Operation<SessionRegistry<T>> {
  // SAFETY: inverse of the erasure performed by installSessionRegistry.
  return SessionRegistryPort.bind(yield* useScope()) as SessionRegistry<T>;
}
