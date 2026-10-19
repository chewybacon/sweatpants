import {
  CrankError,
  exactProgramKey,
  rootTurnIdentity,
  ProgramRouteResolver,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type DurableToolRegistry,
  type EphemeralDurability,
  type NormalizedProgramTrace,
  type PinnedProgram,
  type ProgramElicitResult,
  type ProgramRoute,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import { scoped, type Operation } from "effection";
import {
  createPullResolverRegistry,
  createWaitPullResolver,
  driveActivation,
  driveWorkflowTree,
  durableToolWorkflow,
  hostAuthority,
  installEffectRegistrations,
  JournalAuthorityPort,
  PULL_KIND_SAMPLE,
  PULL_KIND_WAIT,
  settleParkedPull,
  type JournalAuthorityContract,
  type PullResolver,
} from "@sweatpants/journal-authority";
import {
  ModelContextSourceResolverContext,
  ModelContextSourceStagerContext,
  runWithModelSamplingService,
  runWithProgramDeliveryWriter,
  type ModelContextSource,
  type ModelSamplingService,
  type ProgramDeliveryWriter,
} from "@sweatpants/model-sampling";
import {
  ProgramPlacementContext,
  type DurableEffectOutcomeAcknowledger,
  type DurableEffectRegistration,
  type DurableEffectRegistry,
  type OperationOutcome,
} from "@sweatpants/durable-effects";
import type { ModelContext } from "@sweatpants/model-provider";
import { assertDurableEffectBindings } from "@sweatpants/durable-effects/runtime";
export type {
  NormalizedProgramOperationTrace,
  NormalizedProgramTaskTrace,
  NormalizedProgramTrace,
} from "@sweatpants/durable-execution";
export { normalizeProgramTrace } from "./program-trace.ts";
import { normalizeProgramTrace } from "./program-trace.ts";
import {
  assertJson,
  type Json,
  canonicalDigest,
  cloneJson,
  canonicalJson,
} from "@sweatpants/foundation";
import { z } from "zod";
import { EPHEMERAL_TOOL_ADAPTER_PROGRAM } from "@sweatpants/tool-session/ephemeral";

import { createParkedSamplePullResolver } from "./model-sampling/parked-sample-resolver.ts";
import type { ProgramDriverJournal, ProgramDriverJournalStore } from "./program-driver-journal.ts";

export type ProgramCatalogEntry =
  | { kind: "program"; target: string; program: PinnedProgram }
  | {
      kind: "ephemeral-tool";
      target: string;
      driver: string;
      tool: string;
      durability: EphemeralDurability;
    };

export interface PinnedProgramCatalog {
  version: 1;
  digest: string;
  entries: Readonly<Record<string, ProgramCatalogEntry>>;
}

const catalogTextSchema = z.string().min(1).max(4_096);
const pinnedProgramSchema = z.strictObject({
  id: catalogTextSchema,
  version: catalogTextSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
const programCatalogEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("program"),
    target: catalogTextSchema,
    program: pinnedProgramSchema,
  }),
  z.strictObject({
    kind: z.literal("ephemeral-tool"),
    target: catalogTextSchema,
    driver: catalogTextSchema,
    tool: catalogTextSchema,
    durability: z.enum(["opaque", "ephemeral_handle", "crank_native"]),
  }),
]);
const programCatalogEntriesSchema = z.record(catalogTextSchema, programCatalogEntrySchema);
const pinnedProgramCatalogSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: programCatalogEntriesSchema,
});

export interface ProgramWorkflowHostOptions {
  journalStore: ProgramDriverJournalStore;
  programs: DurableToolRegistry;
  effects: DurableEffectRegistry;
  routeResolver?: (program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>;
  modelSamplingService?: ModelSamplingService;
  effectOutcomeAcknowledger?: DurableEffectOutcomeAcknowledger;
  deliveryWriter?: ProgramDeliveryWriter;
  modelContextSourceResolver?: (source: ModelContextSource) => Operation<ModelContext>;
  modelContextSourceStager?: (context: ModelContext) => Operation<ModelContextSource>;
  pullResolvers?: readonly PullResolver[];
  /** Installs deployment-owned APIs inherited by every workflow attachment. */
  setup?: () => Operation<void>;
}

export interface OpenProgramWorkflowRequest {
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  program: PinnedProgram;
  manifest: DurableProgramManifest;
  input: Json;
  catalog: PinnedProgramCatalog;
  route?: ProgramRoute;
}

export interface ProgramWorkflowRun {
  sessionId: string;
  turnId: string;
  taskId: string;
  result: Operation<AdvancementResult>;
}

export interface ProgramWorkflowHost {
  open(request: OpenProgramWorkflowRequest): Operation<ProgramWorkflowRun>;
  resume(sessionId: string): Operation<AdvancementResult>;
  respond(request: {
    sessionId: string;
    taskId: string;
    pullId: string;
    response: ProgramElicitResult;
  }): Operation<AdvancementResult>;
  cancel(sessionId: string, taskId: string, reason?: string): Operation<void>;
  trace(sessionId: string): Operation<NormalizedProgramTrace>;
}

type AcceptedExecution = {
  route: ProgramRoute;
  executionEpoch: number;
  catalog: PinnedProgramCatalog;
};

/**
 * Activation scope for the workflow runtime. Effect registrations install
 * verbatim onto the kernel's installed-effect port;
 * per Decision 1 the journaled input is exactly what the authoring code
 * proposed (no preparation layer).
 */
export interface WorkflowProgramActivationScope {
  readonly attach: AttachProgramRequest;
  readonly driverKind: string;
  readonly effectRegistrations: readonly DurableEffectRegistration[];
  /** Post-resolution bookkeeping (e.g. sampling acknowledgement). */
  readonly onEffectResolved?: (info: {
    readonly pullId: string;
    readonly attemptId: string;
    readonly outcomeDigest: string;
    readonly effect: { readonly name: string; readonly version: string };
  }) => Operation<void>;
  readonly routeResolver?: (
    program: PinnedProgram,
    parentRoute: ProgramRoute,
  ) => Operation<ProgramRoute>;
  readonly modelContextSourceResolver?: (source: ModelContextSource) => Operation<ModelContext>;
  readonly modelContextSourceStager?: (context: ModelContext) => Operation<ModelContextSource>;
  /** Installs deployment-owned scoped APIs inherited by the workflow attachment. */
  readonly setup?: () => Operation<void>;
}

/**
 * Installs authority, placement, effects, context-source composition, and
 * deployment APIs for one workflow attachment.
 */
export function* runWorkflowProgramActivation(
  scope: WorkflowProgramActivationScope,
  drive: (authority: JournalAuthorityContract) => Operation<AdvancementResult>,
): Operation<AdvancementResult> {
  return yield* scoped(function* () {
    const authority = yield* JournalAuthorityPort.use();
    yield* installEffectRegistrations(
      { sessionId: scope.attach.sessionId, taskId: scope.attach.taskId },
      scope.effectRegistrations,
    );
    const journal = yield* authority.query({ type: "authority.identity" });
    return yield* ProgramRouteResolver.with(
      scope.routeResolver
        ? function* ({ program, parentRoute }) {
            return yield* scope.routeResolver!(program, parentRoute);
          }
        : undefined,
      function* () {
        return yield* ProgramPlacementContext.with(
          {
            journal,
            program: scope.attach.program,
            route: scope.attach.route,
            driverKind: scope.driverKind,
          },
          function* () {
            return yield* ModelContextSourceResolverContext.with(
              scope.modelContextSourceResolver,
              function* () {
                return yield* ModelContextSourceStagerContext.with(
                  scope.modelContextSourceStager,
                  function* () {
                    if (scope.setup) {
                      yield* scope.setup();
                    }
                    return yield* drive(authority);
                  },
                );
              },
            );
          },
        );
      },
    );
  });
}

/**
 * Creates an in-process workflow Host owning identity, authority lookup,
 * exact registries, user responses, cancellation, and trace projection.
 */
export function createProgramWorkflowHost(
  options: ProgramWorkflowHostOptions,
): ProgramWorkflowHost {
  // Process-local ownership is only a churn-avoidance hint. Every reuse is
  // checked against authority state; a replacement Host has an empty map and
  // therefore claims newer fences for the complete active task tree.

  function findTool(program: PinnedProgram) {
    return options.programs.get(exactProgramKey(program));
  }

  function verifyLocalProgramRequest(request: OpenProgramWorkflowRequest): void {
    const tool = findTool(request.program);
    if (!tool) {
      throw new CrankError(
        "program_version_unavailable",
        `No exact program ${request.program.id}@${request.program.version}#${request.program.digest}`,
      );
    }
    if (
      request.manifest.programId !== request.program.id ||
      request.manifest.version !== request.program.version ||
      request.manifest.digest !== request.program.digest ||
      canonicalJson(request.manifest) !== canonicalJson(tool.manifest)
    ) {
      throw new CrankError("invalid_manifest", "Program pin and manifest differ");
    }
    verifyPinnedProgramCatalog(request.catalog);
    assertCatalogDispatch(request.catalog, request.program);
    assertDurableEffectBindings(Object.values(request.manifest.effects), options.effects);
  }

  function* runTask(
    journal: ProgramDriverJournal,
    sessionId: string,
    taskId: string,
    program: PinnedProgram,
    input: Json,
    execution: AcceptedExecution,
  ): Operation<AdvancementResult> {
    const rootAttach = {
      sessionId,
      taskId,
      program,
      input,
      route: execution.route,
      executionEpoch: execution.executionEpoch,
    };
    const customResolvers = options.pullResolvers ?? [];
    const customKinds = new Set(customResolvers.map((resolver) => resolver.kind));
    const pullResolvers = createPullResolverRegistry([
      ...customResolvers,

      ...(!customKinds.has(PULL_KIND_SAMPLE) &&
      options.modelSamplingService &&
      options.modelContextSourceResolver
        ? [
            createParkedSamplePullResolver({
              service: options.modelSamplingService,
              *journalIdentity() {
                return yield* journal.query({ type: "authority.identity" });
              },
              sourceResolver: options.modelContextSourceResolver,
            }),
          ]
        : []),

      ...(!customKinds.has(PULL_KIND_WAIT) ? [createWaitPullResolver()] : []),
    ]);
    const route = function* (child: PinnedProgram, parentRoute: ProgramRoute) {
      assertCatalogDispatch(execution.catalog, child);
      return options.routeResolver ? yield* options.routeResolver(child, parentRoute) : parentRoute;
    };
    const activate = function* (request: {
      readonly attach: typeof rootAttach;
    }): Operation<AdvancementResult> {
      const tool = findTool(request.attach.program);
      if (!tool) {
        throw new CrankError(
          "program_version_unavailable",
          `No exact program ${exactProgramKey(request.attach.program)}`,
        );
      }
      return yield* runWorkflowProgramActivation(
        {
          attach: request.attach,
          driverKind: "workflow",
          effectRegistrations: [...options.effects.values()],
          routeResolver: route,
          modelContextSourceResolver: options.modelContextSourceResolver,
          modelContextSourceStager: options.modelContextSourceStager,
          setup: options.setup,
        },
        function* (authority) {
          return yield* driveActivation({
            attach: request.attach,
            authority: hostAuthority(authority),
            workflow: durableToolWorkflow(tool, request.attach.input),
            /* CONDITIONAL-SPREAD: Expose onEffectResolved only when its backing capability exists; callers inspect supported methods. */
            ...(options.effectOutcomeAcknowledger
              ? {
                  *onEffectResolved(info) {
                    yield* options.effectOutcomeAcknowledger!({
                      sessionId: request.attach.sessionId,
                      taskId: request.attach.taskId,
                      pullId: info.pullId,
                      attemptId: info.attemptId,
                      outcomeDigest: info.outcomeDigest,
                      effect: info.effect,
                    });
                  },
                }
              : {}),
          });
        },
      );
    };
    const drive = function* (): Operation<AdvancementResult> {
      const authority = { command: journal.advance, query: journal.query };
      return yield* driveWorkflowTree({
        authority,
        attach: rootAttach,
        rootScope: {
          activate,
          *manifest(child) {
            const tool = findTool(child);
            if (!tool) {
              throw new CrankError(
                "program_version_unavailable",
                `No exact program ${exactProgramKey(child)}`,
              );
            }
            return tool.manifest;
          },
          route,
          *settle(parked, currentAttach) {
            const resolver = pullResolvers.get(parked.reason);
            if (!resolver) {
              return false;
            }
            yield* settleParkedPull({
              authority,
              resolver,
              attach: currentAttach,
              pullId: parked.pullId,
              driverKind: "workflow",
            });
            return true;
          },
        },
      });
    };
    return yield* runWithModelSamplingService(options.modelSamplingService, function* () {
      return yield* runWithProgramDeliveryWriter(options.deliveryWriter, drive);
    });
  }

  function* resumeTask(
    journal: ProgramDriverJournal,
    sessionId: string,
    requestedTaskId?: string,
  ): Operation<AdvancementResult> {
    const recovery = yield* journal.recoveryState(sessionId, requestedTaskId);
    if (recovery.status === "terminal") {
      return outcomeToRunResult(recovery.outcome);
    }
    if (recovery.status === "not_found") {
      throw new CrankError("unknown_target", "No runnable program task in session");
    }

    const program = {
      id: recovery.manifest.programId,
      version: recovery.manifest.version,
      digest: recovery.manifest.digest,
    };
    if (!findTool(program)) {
      throw new CrankError("program_version_unavailable", "Accepted program is unavailable");
    }
    const accepted = yield* acceptedExecution(journal, sessionId, recovery.taskId);
    const rootExecutionEpoch = recovery.activeTasks.find(
      (task) => task.taskId === recovery.taskId,
    )?.executionEpoch;
    if (rootExecutionEpoch === undefined) {
      throw new CrankError("invalid_journal", "Runnable root has no execution epoch");
    }
    return yield* runTask(journal, sessionId, recovery.taskId, program, recovery.input, {
      ...accepted,
      executionEpoch: rootExecutionEpoch,
    });
  }

  return {
    *open(request): Operation<ProgramWorkflowRun> {
      verifyLocalProgramRequest(request);
      const sessionId = request.sessionId ?? `local-session:${crypto.randomUUID()}`;
      return yield* options.journalStore.withJournal(sessionId, function* (journal) {
        const identity = rootTurnIdentity(yield* journal.rootTaskCount(sessionId), {
          /* CONDITIONAL-SPREAD: Omit absent turnId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          /* CONDITIONAL-SPREAD: Omit absent taskId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        });
        const { turnId, taskId } = identity;
        const route = request.route ?? { driverKind: "program" };
        const execution: AcceptedExecution = {
          route,
          executionEpoch: 1,
          catalog: request.catalog,
        };
        const attach = {
          sessionId,
          taskId,
          program: request.program,
          input: request.input,
          route,
          executionEpoch: execution.executionEpoch,
        };
        yield* journal.openTask({
          sessionId,
          turnId,
          taskId,
          manifest: request.manifest,
          input: request.input,
          executionEpoch: execution.executionEpoch,
          attachmentId: stableProgramAttachmentId(attach),
          audience: "workflow-host",
          catalog: assertJson(request.catalog),
          catalogDigest: request.catalog.digest,
          route,
        });
        return {
          sessionId,
          turnId,
          taskId,
          result: options.journalStore.withJournal(sessionId, (activeJournal) =>
            runTask(activeJournal, sessionId, taskId, request.program, request.input, execution),
          ),
        };
      });
    },

    *resume(sessionId): Operation<AdvancementResult> {
      return yield* options.journalStore.withJournal(sessionId, (journal) =>
        resumeTask(journal, sessionId),
      );
    },

    *respond(request): Operation<AdvancementResult> {
      return yield* options.journalStore.withJournal(request.sessionId, function* (journal) {
        const operation = yield* journal.operationState(
          request.sessionId,
          request.taskId,
          request.pullId,
        );
        if (operation.status !== "found" || operation.descriptor.kind !== "elicit") {
          throw new CrankError("unknown_target", "No matching pending elicitation");
        }
        const outcome: OperationOutcome =
          request.response.action === "cancel"
            ? { status: "cancelled" }
            : { status: "ok", value: cloneJson(request.response) };
        if (operation.outcome !== undefined) {
          if (canonicalJson(operation.outcome) !== canonicalJson(outcome)) {
            throw new CrankError("resolution_conflict", "Elicitation response conflicts");
          }
          return yield* resumeTask(journal, request.sessionId);
        }
        const resolution = yield* journal.resolvePending({
          sessionId: request.sessionId,
          taskId: request.taskId,
          pullId: request.pullId,
          audience: operation.audience,
          outcome,
        });
        if (resolution.status === "rejected") {
          throw new CrankError(resolution.code, "Elicitation response was rejected");
        }
        return yield* resumeTask(journal, request.sessionId);
      });
    },

    *cancel(sessionId, taskId, reason): Operation<void> {
      yield* options.journalStore.withJournal(sessionId, (journal) =>
        journal.requestCancellation(sessionId, taskId, reason),
      );
    },

    *trace(sessionId): Operation<NormalizedProgramTrace> {
      return yield* options.journalStore.withJournal(sessionId, function* (journal) {
        const records = yield* journal.readJournal(sessionId);
        return normalizeProgramTrace(records);
      });
    },
  };
}

export function createPinnedProgramCatalog(
  entries: Readonly<Record<string, ProgramCatalogEntry>>,
): PinnedProgramCatalog {
  const canonicalEntries = programCatalogEntriesSchema.parse(cloneJson(entries));
  return {
    version: 1,
    digest: canonicalDigest({ version: 1, entries: canonicalEntries }),
    entries: canonicalEntries,
  };
}

export function verifyPinnedProgramCatalog(catalog: PinnedProgramCatalog): void {
  if (catalog.digest !== canonicalDigest({ version: 1, entries: catalog.entries })) {
    throw new CrankError("invalid_manifest", "Program catalog digest differs from entries");
  }
  for (const [target, entry] of Object.entries(catalog.entries)) {
    if (!target || target !== entry.target) {
      throw new CrankError("invalid_manifest", "Program catalog target differs from its key");
    }
  }
}

/**
 * Decode an untrusted (e.g. journal-persisted) value as a pinned program
 * catalog. The digest covers the canonical entries, so verifying it also
 * authenticates the structural shape of every entry.
 */
function decodePinnedProgramCatalog(value: unknown): PinnedProgramCatalog {
  const parsed = pinnedProgramCatalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new CrankError("invalid_manifest", "Program catalog shape is invalid");
  }
  verifyPinnedProgramCatalog(parsed.data);
  return parsed.data;
}

function isEphemeralCatalogEntry(
  entry: ProgramCatalogEntry,
): entry is Exclude<ProgramCatalogEntry, { kind: "program" }> {
  return entry.kind === "ephemeral-tool";
}

function assertCatalogDispatch(catalog: PinnedProgramCatalog, program: PinnedProgram): void {
  const entries = Object.values(catalog.entries);
  const exact = entries.some(
    (entry) =>
      entry.kind === "program" && exactProgramKey(entry.program) === exactProgramKey(program),
  );
  if (exact) {
    return;
  }

  const ephemeralAdapter =
    exactProgramKey(program) === exactProgramKey(EPHEMERAL_TOOL_ADAPTER_PROGRAM) &&
    entries.some(isEphemeralCatalogEntry);
  if (ephemeralAdapter) {
    return;
  }

  const targetExists = entries.some(
    (entry) =>
      entry.target === program.id || (entry.kind === "program" && entry.program.id === program.id),
  );
  throw new CrankError(
    targetExists ? "invalid_descriptor" : "unknown_target",
    targetExists
      ? `Program pin for target ${program.id} differs from the accepted catalog`
      : `Program target ${program.id} is outside the accepted catalog`,
  );
}

function* acceptedExecution(
  journal: ProgramDriverJournal,
  sessionId: string,
  taskId: string,
): Operation<AcceptedExecution> {
  const state = yield* journal.executionState(sessionId, taskId);
  if (
    state.route === undefined ||
    state.catalog === undefined ||
    state.catalogDigest === undefined
  ) {
    throw new CrankError("invalid_journal", "Task has no authority-owned execution state");
  }
  // The Authority returns Json; decodePinnedProgramCatalog re-verifies the
  // persisted shape before the Host trusts it.
  const catalog = decodePinnedProgramCatalog(state.catalog);
  if (catalog.digest !== state.catalogDigest) {
    throw new CrankError("invalid_journal", "Task catalog differs from authority state");
  }
  return {
    catalog,
    route: structuredClone(state.route),
    executionEpoch: state.executionEpoch,
  };
}

function outcomeToRunResult(outcome: OperationOutcome): AdvancementResult {
  return outcome.status === "ok"
    ? { state: "completed", value: outcome.value }
    : outcome.status === "cancelled"
      ? { state: "cancelled" }
      : { state: "failed", error: outcome.error };
}
