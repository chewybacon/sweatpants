import {
  call,
  createScope,
  suspend,
  useAbortSignal,
  useScope,
  type Operation,
  type Scope,
} from "effection";
import type { FetchHandler, ScopedFetchHandler } from "../handler/streaming.ts";

/** Scoped setup context cancelled when the application closes. */
export interface ChatApplicationSetupContext {
  signal: AbortSignal;
}

/** Fetch application whose root Effection scope is owned until close completes. */
export interface ChatApplication {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Handler and optional scoped setup operation installed at composition. */
export interface ChatApplicationConfig {
  handler: FetchHandler;
  setup?: (ctx: ChatApplicationSetupContext) => Operation<void>;
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

function isScopedFetchHandler(handler: FetchHandler): handler is ScopedFetchHandler {
  return "withScope" in handler && typeof handler.withScope === "function";
}

function isHaltedError(error: unknown): boolean {
  return error instanceof Error && error.message === "halted";
}

/**
 * Creates a lazy, scope-owned chat application. Setup runs once; close cancels
 * and awaits all owned work. Setup defects become a client-safe HTTP response.
 */
export function createChatApplication(config: ChatApplicationConfig): ChatApplication {
  const baseHandler = config.handler;
  const [rootScope, destroyRootScope] = createScope();

  let closed = false;
  let setupPromise: Promise<Scope> | undefined;
  let scopedHandler: FetchHandler | undefined;

  function ensureSetup(): Promise<Scope> {
    if (!setupPromise) {
      setupPromise = new Promise<Scope>((resolve, reject) => {
        let settled = false;
        rootScope
          .run(function* () {
            try {
              const signal = yield* useAbortSignal();
              if (config.setup) {
                yield* config.setup({ signal });
              }
              const scope = yield* useScope();
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

  return {
    async handle(request: Request): Promise<Response> {
      if (closed) {
        throw new ChatApplicationClosedError();
      }
      try {
        const scope = await ensureSetup();
        if (closed) {
          throw new ChatApplicationClosedError();
        }
        if (!scopedHandler) {
          scopedHandler = isScopedFetchHandler(baseHandler)
            ? baseHandler.withScope(scope)
            : (nextRequest) =>
                scope.run(function* () {
                  return yield* call(() => baseHandler(nextRequest));
                });
        }
        return scopedHandler(request);
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
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await destroyRootScope();
      scopedHandler = undefined;
    },
  };
}

export {
  createChatHandler,
  createDurableChatHandler,
  createPluginSessionManager,
  createCapabilityKeyring,
  createDurableTool,
  defineDurableEffect,
  defineDurableProgramManifest,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
  programDriverChatEngineSchemaEntries,
  ProgramDriverForeignEffectsContext,
  ProgramDriverNativeToolsContext,
  ProgramRuntime,
  ProgramPeer,
  JournalAuthority,
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  foreignToolAdapter,
} from "../handler/durable/index.ts";

export { createStreamingHandler, useHandlerContext, HandlerContext } from "../handler/streaming.ts";

/** Crank-native persistence, authoring, and driver contracts for server composition. */
export type {
  DurableProgramContext,
  DurableProgramManifest,
  DurableTool,
  EffectDefinition,
  ForeignDurability,
  ForeignToolDisposition,
  ForeignToolRequest,
  ProgramDriver,
  ProgramDriverJournal,
  ProgramDriverJournalStore,
  ProgramDriverNativeToolBinding,
  ProgramDriverNativeToolComposition,
  InMemoryProgramDriverJournalStoreOptions,
} from "../handler/durable/index.ts";

/** Durable chat handler and plugin-session contracts for application setup. */
export type {
  DurableChatHandlerConfig as ChatHandlerConfig,
  ChatHandlerSetupContext,
  ChatHandlerSetup,
  ChatRequestBody,
  DurableStreamEvent,
  DurableStreamParams,
  ToolSchema,
  McpToolRegistry,
  PluginSessionManager,
  PluginSession,
  PluginSessionStatus,
  PluginSessionEvent,
  PluginSessionInfo,
  PluginSessionManagerOptions,
  CreatePluginSessionConfig,
} from "../handler/durable/index.ts";

/** Streaming handler context and setup contracts. */
export type {
  HandlerContext as HandlerContextValue,
  StreamingHandlerOptions,
  SetupResult,
  SetupFn,
} from "../handler/streaming.ts";
