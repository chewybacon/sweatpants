import { createHostScopeOwner, installHostScopeOwner } from "@sweatpants/durable-chat-runtime/host";
import { installDurableStreamsOwner } from "@sweatpants/durable-chat-runtime/response-streams";
import type { FetchHandler, ScopedEndpoint } from "@sweatpants/durable-chat-runtime/streaming";
import {
  call,
  createScope,
  suspend,
  useAbortSignal,
  useScope,
  type Operation,
  type Scope,
} from "effection";
import type { BoundChatEndpoints } from "./chat-endpoints.ts";
import { createChatRouter, normalizeChatBasePath } from "./chat-router.ts";

export {
  parseTraceContext,
  projectTrustedHttpRequest,
  type TrustedHttpProjection,
  type TrustedProxyPolicy,
} from "./enterprise-http.ts";
export type { DurableChatEndpoints, DurableChatHandlerConfig };

/** Scoped setup context cancelled when the application closes. */
export interface ChatApplicationSetupContext {
  signal: AbortSignal;
}

/** Fetch application whose root Effection scope is owned until close completes. */
export interface ChatApplication {
  handle(request: Request): Promise<Response>;
  handleEndpoint<Input>(
    endpoint: ScopedEndpoint<Input> | ((input: Input) => Promise<Response>),
    input: Input,
  ): Promise<Response>;
  close(): Promise<void>;
}

/** Handler and optional scoped setup operation installed at composition. */
export interface ChatApplicationConfig {
  handler: FetchHandler;
  setup?: (ctx: ChatApplicationSetupContext) => Operation<void>;
  /** Maximum normal drain before remaining Host children are halted. */
  shutdownDeadlineMs?: number;
}

const closedApplicationErrorMessage = "ChatApplication is closed";

/** Boundary-required exception returned when callers use a closed application. */
export class ChatApplicationClosedError extends Error {
  readonly _tag = "ChatApplicationClosedError";

  constructor() {
    super(closedApplicationErrorMessage);
    this.name = "ChatApplicationClosedError";
  }
}

function isScopedEndpoint<Input>(
  endpoint: ScopedEndpoint<Input> | ((input: Input) => Promise<Response>),
): endpoint is ScopedEndpoint<Input> {
  return "withScope" in endpoint && typeof endpoint.withScope === "function";
}

function isHaltedError(error: unknown): boolean {
  return error instanceof Error && error.message === "halted";
}

interface ChatApplicationKernel extends ChatApplication {
  /** Awaits lazy setup and returns the application-owned scope. */
  applicationScope(): Promise<Scope>;
}

/**
 * Creates a lazy, scope-owned chat application. Setup runs once; close cancels
 * and awaits all owned work. Setup defects become a client-safe HTTP response.
 */
export function createChatApplication(config: ChatApplicationConfig): ChatApplication {
  const { handle, handleEndpoint, close } = createChatApplicationKernel(config);
  return { handle, handleEndpoint, close };
}

function createChatApplicationKernel(config: ChatApplicationConfig): ChatApplicationKernel {
  const baseHandler = config.handler;
  const shutdownDeadlineMs = config.shutdownDeadlineMs ?? 30_000;
  if (!Number.isFinite(shutdownDeadlineMs) || shutdownDeadlineMs < 0) {
    throw new Error("ChatApplication shutdownDeadlineMs must be a non-negative finite number");
  }

  const [rootScope, destroyRootScope] = createScope();
  const hostOwner = createHostScopeOwner(rootScope);

  let closed = false;
  let setupPromise: Promise<Scope> | undefined;
  let scopedEndpoints = new WeakMap<object, (input: unknown) => Promise<Response>>();

  function ensureSetup(): Promise<Scope> {
    if (!setupPromise) {
      setupPromise = new Promise<Scope>((resolve, reject) => {
        let settled = false;
        rootScope
          .run(function* () {
            try {
              yield* installHostScopeOwner(hostOwner);
              yield* installDurableStreamsOwner(hostOwner);
              const signal = yield* useAbortSignal();
              if (config.setup) {
                yield* config.setup({ signal });
              }
              const scope = yield* useScope();
              hostOwner.adoptScope(scope);
              settled = true;
              resolve(scope);
              yield* suspend();
            } catch (error) {
              if (!settled) {
                settled = true;
                reject(error);
                return;
              }
              if (!isHaltedError(error)) {
                throw error;
              }
            }
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
      });
    }
    return setupPromise;
  }

  async function handleEndpoint<Input>(
    endpoint: ScopedEndpoint<Input> | ((input: Input) => Promise<Response>),
    input: Input,
  ): Promise<Response> {
    if (closed) {
      throw new ChatApplicationClosedError();
    }
    try {
      const scope = await ensureSetup();
      if (closed) {
        throw new ChatApplicationClosedError();
      }
      let scoped = scopedEndpoints.get(endpoint) as
        | ((nextInput: Input) => Promise<Response>)
        | undefined;
      if (!scoped) {
        scoped = isScopedEndpoint(endpoint)
          ? endpoint.withScope(scope)
          : (nextInput) =>
              scope.run(function* () {
                return yield* call(() => endpoint(nextInput));
              });
        scopedEndpoints.set(endpoint, scoped as (input: unknown) => Promise<Response>);
      }
      return await scoped(input);
    } catch (error) {
      if (closed || (error instanceof Error && error.message === closedApplicationErrorMessage)) {
        throw new ChatApplicationClosedError();
      }
      console.error("[ChatApplication] setup failed", { errorTag: "setup_failed" });
      return new Response(
        JSON.stringify({ type: "error", message: "Chat application setup failed" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  return {
    handle(request: Request): Promise<Response> {
      return handleEndpoint(baseHandler, request);
    },
    handleEndpoint,
    async applicationScope(): Promise<Scope> {
      if (closed) {
        throw new ChatApplicationClosedError();
      }
      return ensureSetup();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rootScope.run(() => hostOwner.drain()),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, shutdownDeadlineMs);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        // Reclaims deadline-exceeding work and runs reachable finalizers.
        await destroyRootScope();
        scopedEndpoints = new WeakMap();
      }
    },
  };
}

import {
  createDurableChatEndpoints,
  type ChatHandlerSetup,
  type DurableChatEndpoints,
  type DurableChatHandlerConfig,
  type DurableChatStorageInspection,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { createChatApi, type ChatApi } from "./chat-api.ts";

/** Host ingress factory over route-independent durable chat capabilities. */
export function createChatEndpoints(config: DurableChatHandlerConfig): DurableChatEndpoints {
  return createDurableChatEndpoints(config);
}

/** Backward-compatible factory for the route-specific POST chat endpoint. */
export function createChatHandler(config: DurableChatHandlerConfig) {
  return createChatEndpoints(config).postChat;
}

export {
  chatStorageFromEnv,
  openChatStorageDatabase,
} from "@sweatpants/durable-chat-runtime/durable-handler";
export type {
  ChatStorageConfig,
  ChatStorageEnvOptions,
  DurableChatCompositionConfig,
  DurableChatIdentityConfig,
  DurableChatProgram,
  DurableChatStorageInspection,
} from "@sweatpants/durable-chat-runtime/durable-handler";

export { ChatApiError } from "./chat-api.ts";
export type { ChatApi, ChatApiInput, ChatHistoryPageInput, ChatPostBody } from "./chat-api.ts";

/** One application owns HTTP routing, direct server calls, and their lifetime. */
export interface ChatApp {
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: ChatApi;
  close(): Promise<void>;
  /** Opens and inspects the application-owned authority storage. */
  inspect(): Promise<DurableChatStorageInspection>;
}

export interface ChatAppSetup {
  /** Runs once in the application scope before its first operation. */
  application?: (ctx: ChatApplicationSetupContext) => Operation<void>;
  /** Runs in the chat execution scope, including reconnect; not history paging. */
  chat?: ChatHandlerSetup;
}

// Distribute Omit over the union so explicit journal composition remains typed.
type WithoutSetup<T> = T extends unknown ? Omit<T, "setup"> : never;
export type ChatAppConfig = WithoutSetup<DurableChatHandlerConfig> & {
  /** Route prefix; defaults to /api/chat. */
  basePath?: string;
  /** Origin used for direct API requests; defaults to http://sweatpants.local. */
  baseURL?: string;
  setup?: ChatAppSetup;
  /** Maximum graceful drain before close halts remaining work. */
  shutdownDeadlineMs?: number;
};

/** Creates a lazy application. Mount handler once at basePath and its children. */
export function createChatApp(config: ChatAppConfig): ChatApp {
  const { setup, shutdownDeadlineMs, basePath: path, baseURL, ...options } = config;
  // JavaScript callers also receive a composition error for an invalid setup shape.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (setup !== undefined && (setup === null || typeof setup !== "object")) {
    throw new TypeError("ChatApp setup must contain application and/or chat functions");
  }
  const basePath = normalizeChatBasePath(path ?? "/api/chat");
  const origin = new URL(baseURL ?? "http://sweatpants.local");
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new TypeError("ChatApp baseURL must be an HTTP(S) origin without a path or credentials");
  }
  const endpoints = createChatEndpoints({
    ...options,
    ...(setup?.chat ? { setup: setup.chat } : {}),
  });
  const kernel = createChatApplicationKernel({
    handler: endpoints.postChat,
    ...(setup?.application ? { setup: setup.application } : {}),
    ...(shutdownDeadlineMs === undefined ? {} : { shutdownDeadlineMs }),
  });
  let closed = false;
  const bound: BoundChatEndpoints = {
    postChat: (request) => kernel.handleEndpoint(endpoints.postChat, request),
    readChat: (input) => kernel.handleEndpoint(endpoints.readChat, input),
    pageHistory: (input) => kernel.handleEndpoint(endpoints.pageHistory, input),
  };
  const route = createChatRouter(basePath, bound);
  const handler = async (request: Request): Promise<Response> => {
    if (closed) {
      throw new ChatApplicationClosedError();
    }
    return route(request);
  };
  return {
    handler,
    api: createChatApi(bound, origin.origin, basePath),
    async close() {
      closed = true;
      await kernel.close();
    },
    inspect: () => kernel.applicationScope().then((scope) => endpoints.inspect(scope)),
  };
}
