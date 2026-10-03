/**
 * Resolves storage once per application owner and wires independent endpoints.
 * POST owns command admission; reads own checkpoint/reconnect selection;
 * history owns paging authorization. Live Turns share execution and publication.
 */
import type { Scope } from "effection";
import type { ScopedEndpoint } from "../streaming.ts";
import type { ChatExecutionContext } from "./chat-execution-context.ts";
import {
  resolveDurableChatComposition,
  type ResolvedDurableChatComposition,
} from "./configuration.ts";
import { createDurableHistoryPageEndpoint } from "./history-page-endpoint.ts";
import { createPostChatEndpoint } from "./post-chat-endpoint.ts";
import { createReadChatEndpoint } from "./read-chat-endpoint.ts";
import {
  assertChatSqliteStorageVariant,
  chatStorageForScope,
  resolveImmediateChatStorage,
  type ChatStorageConfig,
  type ResolvedChatStorage,
} from "./storage.ts";
import type {
  DurableChatEndpoints,
  DurableChatHandlerConfig,
  DurableChatStorageInspection,
} from "./types.ts";
/** Storage kinds that open one handle per application scope. */
function isScopedChatStorage(
  config: ChatStorageConfig,
): config is Extract<ChatStorageConfig, { readonly kind: "sqlite" | "postgres" }> {
  return config.kind === "sqlite" || config.kind === "postgres";
}

type DurableChatEndpointSet = Pick<DurableChatEndpoints, "postChat" | "readChat" | "pageHistory">;

interface ResolvedEndpointBundle {
  readonly endpoints: DurableChatEndpointSet;
  readonly inspection: DurableChatStorageInspection;
}

function bindEndpointSet(endpoints: DurableChatEndpointSet, scope: Scope): DurableChatEndpointSet {
  return {
    postChat: Object.assign(endpoints.postChat.withScope(scope), {
      withScope: (nextScope: Scope) => endpoints.postChat.withScope(nextScope),
    }),
    readChat: Object.assign(endpoints.readChat.withScope(scope), {
      withScope: (nextScope: Scope) => endpoints.readChat.withScope(nextScope),
    }),
    pageHistory: Object.assign(endpoints.pageHistory.withScope(scope), {
      withScope: (nextScope: Scope) => endpoints.pageHistory.withScope(nextScope),
    }),
  };
}

/**
 * Create route-independent durable chat endpoint capabilities.
 *
 * SQLite and Postgres resolution is deferred until the first request bound to an
 * application scope. Memory and custom stores are resolved synchronously.
 */
export function createDurableChatEndpoints(config: DurableChatHandlerConfig): DurableChatEndpoints {
  if (!config.storage) {
    throw new TypeError("Durable chat storage is required");
  }
  if (config.storage.kind === "sqlite") {
    assertChatSqliteStorageVariant(config.storage);
  }
  const composition = resolveDurableChatComposition(config);

  const immediateBundle = isScopedChatStorage(config.storage)
    ? undefined
    : createResolvedDurableChatEndpoints(
        config,
        composition,
        resolveImmediateChatStorage(config.storage),
      );
  const scopedBundles = new WeakMap<Scope, Promise<ResolvedEndpointBundle>>();

  const bundleForScope = (scope: Scope): Promise<ResolvedEndpointBundle> => {
    const current = scopedBundles.get(scope);
    if (current) {
      return current;
    }
    const resolving = isScopedChatStorage(config.storage)
      ? chatStorageForScope(config.storage, scope).then((storage) => {
          const bundle = createResolvedDurableChatEndpoints(config, composition, storage);
          return {
            endpoints: bindEndpointSet(bundle.endpoints, scope),
            inspection: bundle.inspection,
          };
        })
      : Promise.resolve({
          endpoints: bindEndpointSet(immediateBundle!.endpoints, scope),
          inspection: immediateBundle!.inspection,
        });
    scopedBundles.set(scope, resolving);
    return resolving;
  };

  const deferredEndpoint = <Input>(
    select: (endpoints: DurableChatEndpointSet) => ScopedEndpoint<Input>,
  ): ScopedEndpoint<Input> => {
    const endpoint = async (input: Input): Promise<Response> => {
      if (!immediateBundle) {
        throw new Error(
          "Persistent durable chat endpoints must be bound to an application-owned scope",
        );
      }
      return select(immediateBundle.endpoints)(input);
    };
    endpoint.withScope =
      (scope: Scope) =>
      async (input: Input): Promise<Response> =>
        select((await bundleForScope(scope)).endpoints)(input);
    return endpoint;
  };

  return {
    postChat: deferredEndpoint((endpoints) => endpoints.postChat),
    readChat: deferredEndpoint((endpoints) => endpoints.readChat),
    pageHistory: deferredEndpoint((endpoints) => endpoints.pageHistory),
    inspect: (scope) => bundleForScope(scope).then((bundle) => bundle.inspection),
  };
}

function createResolvedDurableChatEndpoints(
  config: DurableChatHandlerConfig,
  composition: ResolvedDurableChatComposition,
  storage: ResolvedChatStorage,
): ResolvedEndpointBundle {
  const { executionStore, conversationStore } = storage;
  const projectionTokens = composition.projectionTokens;
  const programDriverJournalStore = composition.createJournalStore(executionStore);
  const execution: ChatExecutionContext = {
    config,
    storage,
    projectionTokens,
    programDriverJournalStore,
    liveProgramActivations: new Map(),
  };
  const postChat = createPostChatEndpoint(execution);
  const readChat = createReadChatEndpoint(execution);
  const pageHistory = createDurableHistoryPageEndpoint(
    {
      projectionTokens,
      authorizeHistoryRead: composition.authorizeHistoryRead,
      ...(config.projectionTokenTtlMs === undefined
        ? {}
        : { projectionTokenTtlMs: config.projectionTokenTtlMs }),
    },
    conversationStore,
  );
  return {
    endpoints: { postChat, readChat, pageHistory },
    inspection: { conversationStore, executionStore, programDriverJournalStore },
  };
}

/** Backward-compatible name for the route-specific POST chat endpoint. */
export function createDurableChatHandler(
  config: DurableChatHandlerConfig,
): ScopedEndpoint<Request> {
  return createDurableChatEndpoints(config).postChat;
}
