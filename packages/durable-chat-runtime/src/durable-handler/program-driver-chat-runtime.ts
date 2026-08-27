import {
  ProgramPlacementContext,
  type DurableEffectRegistration,
} from "@sweatpants/durable-effects";
import {
  createDurableEffectRegistry,
  DurableEffectRegistryContext,
  DurableEffects,
  DurableEffectRouting,
  effectContractDigest,
} from "@sweatpants/durable-effects/runtime";
import {
  createPullResolverRegistry,
  createWaitPullResolver,
  createWorkflowProgramDriver,
  driveProgramDriverActivation,
  driveWorkflowTree,
  modelPullOwnerFence,
  settleParkedPull,
  type JournalAuthorityContract,
} from "@sweatpants/journal-authority";
import {
  ExecutionModelSamplingServiceContext,
  MODEL_SAMPLE_CONTRACT,
  ModelContextSourceResolverContext,
  type ModelContextSource,
} from "@sweatpants/model-sampling";
import { type Operation } from "effection";
import {
  CrankError,
  createDurableToolRegistry,
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  type AdvancementResult,
  type AttachProgramRequest,
  type PinnedProgram,
  type ProgramRoute,
  exactProgramKey,
} from "@sweatpants/durable-execution";
import { foreignToolAdapter } from "@sweatpants/tool-session/foreign";

import { createParkedSamplePullResolver } from "./parked-sample-resolver.ts";
import { createToolRuntimeForeignEffectRegistrations } from "./program-driver-tool-runtime.ts";
import type { ProgramDriverJournal } from "./program-driver-journal.ts";
import {
  manifest,
  type ChatProgramInput,
  type ChatToolCatalogEntry,
} from "./program-driver-schema.ts";
import {
  createHostModelSamplingService,
  stageProgramDriverModelSampleInput,
  preparedModelContextByteLimit,
  resolveModelContextSource,
  stageModelContextSource,
} from "./model-sampling/service.ts";
import { runWorkflowProgramActivation } from "./program-workflow-host.ts";
import { rootTool } from "./program-driver-chat-program.ts";
import type { Model, StreamOptions } from "@sweatpants/model-provider";
import type { HistoryPolicy } from "@sweatpants/chat-core";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import type { ToolInventoryEntry, ToolRuntime } from "@sweatpants/tool-runtime";
import type { ProgramDriverNativeToolComposition } from "../program-driver/native-tools.ts";

export interface ChatExecutionEnvironment {
  readonly sessionId: string;
  readonly sampling: {
    readonly model: Model;
    readonly conversationStore: ConversationStore;
    readonly streamOptions?: StreamOptions;
    readonly historyPolicy?: HistoryPolicy;
  };
  readonly native?: ProgramDriverNativeToolComposition;
  readonly ephemeral: {
    readonly effects?: readonly [DurableEffectRegistration, DurableEffectRegistration];
    readonly runtime?: ToolRuntime;
    readonly inventory: readonly ToolInventoryEntry[];
    readonly threadId: string;
    readonly runId: string;
  };
}

export interface ChatExecutionRuntime {
  readonly liveMessageIds: ReadonlySet<string>;
  readonly endedLiveMessageIds: ReadonlySet<string>;
  driveTreeAtEpoch(
    executionEpoch: number,
    activationOwnerId?: string,
  ): Operation<AdvancementResult>;
}

export function* composeChatExecutionRuntime(
  environment: ChatExecutionEnvironment,
  journal: ProgramDriverJournal,
  input: ChatProgramInput,
  attach: AttachProgramRequest,
): Operation<ChatExecutionRuntime> {
  const scopedEphemeralEffects = environment.ephemeral.effects;
  // SAFETY: registry storage erases manifest type witnesses; both tools are
  // restored from their exact pinned schemas before driver execution.
  const tools = createDurableToolRegistry([
    rootTool,
    foreignToolAdapter,
    ...[...(environment.native?.bindings.values() ?? [])].map((binding) => binding.tool),
  ]);
  const executionModelSamplingService = yield* ExecutionModelSamplingServiceContext.get();
  const liveMessageIds = new Set<string>();
  const endedLiveMessageIds = new Set<string>();
  const boundEphemeralDriver = Object.values(input.catalog.entries).find(
    (
      entry,
    ): entry is ChatToolCatalogEntry & {
      execution: Extract<ChatToolCatalogEntry["execution"], { kind: "foreign-tool" }>;
    } => entry.execution.kind === "foreign-tool",
  )?.execution.driver;
  const ephemeralEffects =
    boundEphemeralDriver === "tool-session"
      ? requireScopedEphemeralEffects(scopedEphemeralEffects)
      : boundEphemeralDriver === "chat-tool-runtime"
        ? createToolRuntimeForeignEffectRegistrations({
            runtime: requireToolRuntime(environment.ephemeral.runtime),
            entries: environment.ephemeral.inventory,
            threadId: environment.ephemeral.threadId,
            runId: environment.ephemeral.runId,
          })
        : [];
  const samplingServiceOptions = {
    model: environment.sampling.model,
    ...(environment.sampling.streamOptions
      ? { streamOptions: environment.sampling.streamOptions }
      : {}),
    catalog: input.catalog,
    ...(environment.sampling.historyPolicy
      ? { historyPolicy: environment.sampling.historyPolicy }
      : {}),
    onLiveMessageStarted(messageId: string) {
      liveMessageIds.add(messageId);
    },
    onLiveMessageEnded(messageId: string) {
      endedLiveMessageIds.add(messageId);
    },
  };
  const hostModelSamplingService = createHostModelSamplingService({
    ...samplingServiceOptions,
    journal,
    conversationStore: environment.sampling.conversationStore,
    conversationId: environment.sessionId,
  });
  const routeResolverFn = function* (
    program: PinnedProgram,
    parentRoute: ProgramRoute,
  ): Operation<ProgramRoute> {
    const binding = [...(environment.native?.bindings.values() ?? [])].find(
      (candidate) =>
        candidate.tool.manifest.programId === program.id &&
        candidate.tool.manifest.version === program.version &&
        candidate.tool.manifest.digest === program.digest,
    );
    return binding?.route ?? parentRoute;
  };
  const hostEffectRegistrations = [...ephemeralEffects, ...(environment.native?.effects ?? [])];
  const executionEffects = createDurableEffectRegistry(
    hostEffectRegistrations,
    Object.values(manifest.effects),
  );
  // Full cutover: local, worker, and remote placements all speak the same
  // ProgramDriver replay/advancement protocol. Placement changes transport,
  // never replay semantics.
  const drivers = createProgramDriverRegistry([
    ...(environment.native?.drivers ?? []),
    ["program", createWorkflowProgramDriver(tools)],
  ]);
  // Shared context-source resolver for sampling on both activation paths.
  const modelContextSourceResolver = function* (source: ModelContextSource) {
    return yield* resolveModelContextSource(source, {
      conversationStore: environment.sampling.conversationStore,
      journal,
      maxCanonicalBytes: preparedModelContextByteLimit(environment.sampling.model.contextWindow),
    });
  };

  // Host-owned parked interaction transports. Child composition remains
  // topology and is handled by driveWorkflowTree rather than this registry.
  const parkedPullResolvers = createPullResolverRegistry([
    createParkedSamplePullResolver({
      service: function* (context) {
        if (!context.placement) {
          throw new CrankError(
            "sample_pull_unresolved",
            "Model sampling route requires attachment placement",
          );
        }
        const routed = yield* DurableEffectRouting.operations.route({
          definition: MODEL_SAMPLE_CONTRACT,
          effectContractDigest: effectContractDigest(MODEL_SAMPLE_CONTRACT),
          sessionId: context.sessionId,
          taskId: context.taskId,
          pullId: context.pullId,
          attemptId: modelPullOwnerFence(context.pullId, context.placement.executionEpoch),
          program: context.placement.program,
          programRoute: context.placement.route,
        });
        if (routed.placement === "host") {
          return { service: hostModelSamplingService, executor: "host" };
        }
        if (routed.placement === "execution" && executionModelSamplingService) {
          return { service: executionModelSamplingService, executor: "execution" };
        }
        throw new CrankError(
          "effect_placement_unavailable",
          "Selected model-sampling service is unavailable",
        );
      },
      *journalIdentity() {
        return yield* journal.withAuthority((authority) =>
          authority.query({ type: "authority.identity" }),
        );
      },
      sourceResolver: modelContextSourceResolver,
    }),
    createWaitPullResolver(),
  ]);

  const activateTask = function* (
    authority: JournalAuthorityContract,
    request: { readonly attach: AttachProgramRequest },
    activationOwnerId?: string,
  ): Operation<AdvancementResult> {
    const kind = routeDriverKind(request.attach.route);
    const driver = drivers.get(kind);
    if (!driver) {
      throw new CrankError("unknown_target", `No program driver for ${kind}`);
    }
    const drive = (selectedAuthority: JournalAuthorityContract): Operation<AdvancementResult> =>
      ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* ModelContextSourceResolverContext.with(
          modelContextSourceResolver,
          function* () {
            return yield* DurableEffectRegistryContext.with(executionEffects, function* () {
              return yield* driveProgramDriverActivation({
                authority: selectedAuthority,
                driver,
                attach: request.attach,
                ...(activationOwnerId === undefined ? {} : { activationOwnerId }),
                *stageSampleInput(input) {
                  return yield* stageProgramDriverModelSampleInput(input, environment.sessionId);
                },
                effects: {
                  *route({ authorization, definition }) {
                    if (kind === "program") return "execution";
                    const routed = yield* DurableEffectRouting.operations.route({
                      definition,
                      effectContractDigest: authorization.effectContractDigest,
                      sessionId: authorization.sessionId,
                      taskId: authorization.taskId,
                      pullId: authorization.pullId,
                      attemptId: authorization.attemptId,
                      program: request.attach.program,
                      programRoute: request.attach.route,
                    });
                    if (routed.placement !== "host" && routed.placement !== "execution") {
                      throw new CrankError(
                        "effect_placement_unavailable",
                        "Effect route is invalid",
                      );
                    }
                    return routed.placement;
                  },
                  *executeHost(authorization, placement) {
                    return yield* ProgramPlacementContext.with(placement, function* () {
                      return yield* DurableEffects.operations.execute(authorization);
                    });
                  },
                },
              });
            });
          },
        );
      });

    if (kind !== "program") {
      if (environment.native?.setup) yield* environment.native.setup();
      return yield* drive(authority);
    }
    return yield* runWorkflowProgramActivation(
      {
        installAuthority: () => journal.install(),
        attach: request.attach,
        driverKind: "workflow",
        effectRegistrations: hostEffectRegistrations,
        routeResolver: routeResolverFn,
        modelContextSourceResolver,
        modelContextSourceStager: (context) =>
          stageModelContextSource(context, environment.sessionId),
        ...(environment.native?.setup ? { setup: environment.native.setup } : {}),
      },
      drive,
    );
  };

  const driveTreeAtEpoch = function* (
    executionEpoch: number,
    activationOwnerId?: string,
  ): Operation<AdvancementResult> {
    const rootAttach = { ...attach, executionEpoch };
    return yield* journal.withAuthority(function* (authority) {
      return yield* driveWorkflowTree({
        authority,
        attach: rootAttach,
        rootScope: {
          activate(request) {
            return activateTask(authority, request, activationOwnerId);
          },
          *manifest(program) {
            const tool = tools.get(exactProgramKey(program));
            if (!tool) {
              throw new CrankError(
                "program_version_unavailable",
                `No pinned program ${exactProgramKey(program)}`,
              );
            }
            return tool.manifest;
          },
          route: routeResolverFn,
          *settle(parked, currentAttach) {
            const resolver = parkedPullResolvers.get(parked.reason);
            if (!resolver) {
              return false;
            }
            yield* settleParkedPull({
              authority,
              resolver,
              attach: currentAttach,
              pullId: parked.pullId,
              driverKind: routeDriverKind(currentAttach.route),
            });
            return true;
          },
        },
      });
    });
  };
  return { driveTreeAtEpoch, liveMessageIds, endedLiveMessageIds };
}

function routeDriverKind(route: ProgramRoute): string {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    return "program";
  }
  const kind = route["driverKind"] ?? route["kind"];
  return typeof kind === "string" && kind.length > 0 ? kind : "program";
}

function requireScopedEphemeralEffects(
  registrations: readonly [DurableEffectRegistration, DurableEffectRegistration] | undefined,
) {
  if (!registrations) {
    throw new CrankError(
      "foreign_driver_not_installed",
      "The recorded tool-session foreign driver is not installed",
    );
  }
  return registrations;
}

function requireToolRuntime(runtime: ToolRuntime | undefined) {
  if (!runtime) {
    throw new CrankError("tool_runtime_not_installed", "Tool runtime is not installed");
  }
  return runtime;
}
