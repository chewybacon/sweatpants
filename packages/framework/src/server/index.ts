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
import { createHostScopeOwner, installHostScopeOwner } from "../lib/effection/host-scope.ts";

export {
  AgentFacadeError,
  defineAgent,
  remoteExecutor,
  serveAgent,
  standardA2A,
  sweatpantsPeer,
  type AgentFacadeErrorCode,
  type AgentProfileKind,
  type AgentProjectionBase,
  type AgentServingProfile,
  type PeerEffectRoutePolicy,
  type PublicAgentDeployment,
  type RemoteExecutorProfile,
  type RemoteExecutorServedAgent,
  type ServedAgent,
  type StandardA2AHostPort,
  type StandardA2AProfile,
  type StandardA2AServedAgent,
  type SweatpantsPeerProfile,
  type SweatpantsPeerServedAgent,
} from "./agent-profiles.ts";
export {
  agentCardSigningProjection,
  createAgentCardJwsSigner,
  type AgentCardSignatureV1,
  type AgentCardSigner,
} from "./agent-card-signing.ts";
export {
  parseTraceContext,
  projectTrustedHttpRequest,
  type TrustedHttpProjection,
  type TrustedProxyPolicy,
} from "./enterprise-http.ts";
export {
  createStandardA2AMetrics,
  type StandardA2AMetricsSnapshot,
} from "./standard-a2a-metrics.ts";
export {
  StandardA2AHostError,
  StandardA2ATraceContext,
  createInMemoryStandardA2ATaskDirectory,
  createStandardA2AHost,
  type BoundStandardA2AHost,
  type CreateStandardA2AHostOptions,
  type StandardA2AAuthorizationAction,
  type StandardA2AContinuationBinding,
  type StandardA2AEvidence,
  type StandardA2AExternalContentBinding,
  type StandardA2AHistoryProjection,
  type StandardA2AHostBinding,
  type StandardA2AHostErrorCode,
  type StandardA2AHostLimits,
  type StandardA2ARequestContext,
  type StandardA2ARetentionPolicy,
  type StandardA2AStreamEvent,
  type StandardA2ATaskDirectory,
  type StandardA2ATaskDirectoryEntry,
  type StandardA2ATelemetryEvent,
} from "./standard-a2a-host.ts";
export {
  assertRemoteReferenceUsable,
  connectPeerAgent,
  connectRemoteExecutor,
  connectStandardAgent,
  createDurableRemoteReference,
  requirePeerAgentHandle,
  requireRemoteExecutorHandle,
  requireStandardAgentHandle,
  type DurableRemoteReferenceV1,
  type DynamicRemoteExecutorHandle,
  type DynamicStandardAgentHandle,
  type ExpectedRemoteProgramContract,
  type PeerAgentHandle,
  type RemoteExecutorHandle,
  type StandardAgentHandle,
} from "./agent-connections.ts";

/** Scoped setup context cancelled when the application closes. */
export interface ChatApplicationSetupContext {
  signal: AbortSignal;
}

/** Fetch application whose root Effection scope is owned until close completes. */
export interface ChatApplication {
  handle(request: Request): Promise<Response>;
  close(options?: { mode?: "graceful" | "catastrophic" }): Promise<void>;
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
  const hostOwner = createHostScopeOwner(rootScope);
  const shutdownDeadlineMs = config.shutdownDeadlineMs ?? 30_000;
  if (!Number.isFinite(shutdownDeadlineMs) || shutdownDeadlineMs < 0) {
    throw new Error("ChatApplication shutdownDeadlineMs must be a non-negative finite number");
  }

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
              yield* installHostScopeOwner(hostOwner);
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
    async close(closeOptions: { mode?: "graceful" | "catastrophic" } = {}): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (closeOptions.mode !== "catastrophic") {
          await Promise.race([
            rootScope.run(() => hostOwner.drain()),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, shutdownDeadlineMs);
            }),
          ]);
        }
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        // Reclaims deadline-exceeding work and runs reachable finalizers.
        await destroyRootScope();
        scopedHandler = undefined;
      }
    },
  };
}

export {
  createChatHandler,
  createDurableChatHandler,
  createPluginSessionManager,
  createCapabilityKeyring,
  createPinnedDurableProgram,
  defineDurableEffect,
  defineDurableProgramManifest,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createInMemoryProgramDriverJournalStore,
  createLocalProgramHost,
  createPinnedProgramCatalog,
  normalizeProgramTrace,
  firstTraceDivergence,
  runProgramDriverConformance,
  runLocalProgramActivation,
  createProgramDeliveryWriter,
  highestRemoteOriginLsn,
  projectProgramDeliveryEnvelope,
  validateCatalog,
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
  LocalProgramHost,
  LocalProgramActivationScope,
  LocalProgramHostOptions,
  LocalProgramRun,
  NormalizedProgramTrace,
  OpenLocalProgramRequest,
  PinnedProgramCatalog,
  ProgramCatalogEntry,
  ProgramDriverConformanceCase,
  ProgramDriverConformanceEvidence,
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
