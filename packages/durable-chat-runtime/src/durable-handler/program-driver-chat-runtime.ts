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
import type { ProgramDriverChatEngineParams } from "./program-driver-chat-types.ts";
import type { WorkflowChatEngineParams } from "./types.ts";

export interface ChatExecutionRuntime {
  readonly liveMessageIds: ReadonlySet<string>;
  readonly endedLiveMessageIds: ReadonlySet<string>;
  driveTreeAtEpoch(
    executionEpoch: number,
    activationOwnerId?: string,
  ): Operation<AdvancementResult>;
}

export function* composeChatExecutionRuntime(
  params: ProgramDriverChatEngineParams,
  journal: ProgramDriverJournal,
  input: ChatProgramInput,
  attach: AttachProgramRequest,
): Operation<ChatExecutionRuntime> {
  const scopedForeignEffects = params.foreignEffects;
  // SAFETY: registry storage erases manifest type witnesses; both tools are
  // restored from their exact pinned schemas before driver execution.
  const tools = createDurableToolRegistry([
    rootTool,
    foreignToolAdapter,
    ...[...(params.nativeTools?.bindings.values() ?? [])].map((binding) => binding.tool),
  ]);
  const executionModelSamplingService = yield* ExecutionModelSamplingServiceContext.get();
  const liveMessageIds = new Set<string>();
  const endedLiveMessageIds = new Set<string>();
  const boundForeignDriver = Object.values(input.catalog.entries).find(
    (
      entry,
    ): entry is ChatToolCatalogEntry & {
      execution: Extract<ChatToolCatalogEntry["execution"], { kind: "foreign-tool" }>;
    } => entry.execution.kind === "foreign-tool",
  )?.execution.driver;
  const foreignEffects =
    boundForeignDriver === "tool-session"
      ? requireScopedForeignEffects(scopedForeignEffects)
      : boundForeignDriver === "chat-tool-runtime"
        ? createToolRuntimeForeignEffectRegistrations({
            runtime: requireToolRuntime(params),
            entries: params.toolInventoryEntries ?? [],
            threadId: params.agUiRun.threadId,
            runId: params.agUiRun.runId,
          })
        : [];
  const samplingServiceOptions = {
    model: params.model,
    ...(params.streamOptions ? { streamOptions: params.streamOptions } : {}),
    catalog: input.catalog,
    ...(params.historyPolicy ? { historyPolicy: params.historyPolicy } : {}),
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
    conversationStore: params.conversationStore,
    conversationId: params.conversationId,
  });
  const routeResolverFn = function* (
    program: PinnedProgram,
    parentRoute: ProgramRoute,
  ): Operation<ProgramRoute> {
    const binding = [...(params.nativeTools?.bindings.values() ?? [])].find(
      (candidate) =>
        candidate.tool.manifest.programId === program.id &&
        candidate.tool.manifest.version === program.version &&
        candidate.tool.manifest.digest === program.digest,
    );
    return binding?.route ?? parentRoute;
  };
  const hostEffectRegistrations = [...foreignEffects, ...(params.nativeTools?.effects ?? [])];
  const executionEffects = createDurableEffectRegistry(
    hostEffectRegistrations,
    Object.values(manifest.effects),
  );
  // Full cutover: local, worker, and remote placements all speak the same
  // ProgramDriver replay/advancement protocol. Placement changes transport,
  // never replay semantics.
  const drivers = createProgramDriverRegistry([
    ...(params.nativeTools?.drivers ?? []),
    ["program", createWorkflowProgramDriver(tools)],
  ]);
  // Shared context-source resolver for sampling on both activation paths.
  const modelContextSourceResolver = function* (source: ModelContextSource) {
    return yield* resolveModelContextSource(source, {
      conversationStore: params.conversationStore,
      journal,
      maxCanonicalBytes: preparedModelContextByteLimit(params.model.contextWindow),
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
                  return yield* stageProgramDriverModelSampleInput(input, params.conversationId);
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
      if (params.nativeTools?.setup) yield* params.nativeTools.setup();
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
          stageModelContextSource(context, params.conversationId),
        ...(params.nativeTools?.setup ? { setup: params.nativeTools.setup } : {}),
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

function requireScopedForeignEffects(
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

function requireToolRuntime(params: WorkflowChatEngineParams) {
  if (!params.toolRuntime) {
    throw new CrankError("tool_runtime_not_installed", "Tool runtime is not installed");
  }
  return params.toolRuntime;
}
