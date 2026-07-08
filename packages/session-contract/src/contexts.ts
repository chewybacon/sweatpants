import { createContext, type Operation } from "effection";

import {
  SessionContractError,
  type CapabilityResolver,
  type LogRecord,
  type ModelProvider,
  type PostOrphanPolicy,
} from "./types.ts";
import type { TokenBufferStore } from "./in-memory-session.ts";

export const CapabilityResolverContext = createContext<CapabilityResolver | undefined>(
  "session-contract:resolver",
  undefined,
);

export const ModelProviderContext = createContext<ModelProvider | undefined>(
  "session-contract:model-provider",
  undefined,
);

export const PostOrphanPolicyContext = createContext<PostOrphanPolicy | undefined>(
  "session-contract:post-orphan-policy",
  undefined,
);

export function* useCapabilityResolver(): Operation<CapabilityResolver> {
  const resolver = yield* CapabilityResolverContext.get();
  if (!resolver) {
    throw new SessionContractError("unknown_target", "No capability resolver is bound in scope");
  }
  return resolver;
}

export function* useModelProvider(): Operation<ModelProvider> {
  const provider = yield* ModelProviderContext.get();
  if (!provider) {
    throw new SessionContractError("unsupported_operation", "No model provider is bound in scope");
  }
  return provider;
}

export function* usePostOrphanPolicy(): Operation<PostOrphanPolicy> {
  return (yield* PostOrphanPolicyContext.get()) ?? "park";
}

/**
 * Context for a shared {@link TokenBufferStore}<LogRecord> that persists fold
 * session logs across HTTP requests. When set, the durable adapter reopens
 * the existing fold session on resume instead of creating an ephemeral one.
 *
 * This follows the same context/DI pattern as the durable-streams
 * `TokenBufferStoreContext`: the app sets up a shared store once at startup,
 * and request handlers read it from context.
 */
export const FoldSessionBufferStoreContext = createContext<TokenBufferStore<LogRecord> | undefined>(
  "session-contract:fold-session-buffer-store",
  undefined,
);

/**
 * Get the fold session buffer store from context. Throws if not configured.
 */
export function* useFoldSessionBufferStore(): Operation<TokenBufferStore<LogRecord>> {
  const store = yield* FoldSessionBufferStoreContext.get();
  if (!store) {
    throw new SessionContractError(
      "unknown_target",
      "No fold session buffer store is bound in scope. " +
        "Set FoldSessionBufferStoreContext at app startup.",
    );
  }
  return store;
}

/**
 * Get the fold session buffer store from context, or `undefined` if not set.
 * Callers that have a fallback (e.g. the adapter falling back to an ephemeral
 * session) should prefer this over {@link useFoldSessionBufferStore}.
 */
export function* useOptionalFoldSessionBufferStore(): Operation<
  TokenBufferStore<LogRecord> | undefined
> {
  return yield* FoldSessionBufferStoreContext.get();
}
