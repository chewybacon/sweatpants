import { type DurableEffectRegistry, type OperationOutcome } from "@sweatpants/durable-effects";

import { CrankError } from "@sweatpants/durable-execution";
import { type Operation } from "effection";
import { withJournalAuthority, type DurableSemanticRecord } from "@sweatpants/journal-authority";
import { ProgramRouteResolverContext } from "@sweatpants/durable-execution";
import { ProgramRuntime } from "@sweatpants/durable-execution";
import {
  runWithModelSamplingService,
  runWithProgramDeliveryWriter,
  type ModelSamplingService,
  type ProgramDeliveryWriter,
} from "@sweatpants/model-sampling";
import {
  DurableEffectOutcomeAcknowledgerContext,
  type DurableEffectOutcomeAcknowledger,
} from "@sweatpants/durable-effects";
import {
  DurableEffectRegistryContext,
  assertDurableEffectBindings,
} from "@sweatpants/durable-effects/runtime";
import {
  exactProgramKey,
  stableProgramAttachmentId,
  type DurableProgramManifest,
  type ForeignDurability,
  type PinnedProgram,
  type ProgramRoute,
  type ProgramRunResult,
  type ProgramElicitResult,
  type NormalizedProgramOperationTrace,
  type NormalizedProgramTaskTrace,
  type NormalizedProgramTrace,
} from "@sweatpants/durable-execution";
export type { NormalizedProgramOperationTrace, NormalizedProgramTaskTrace, NormalizedProgramTrace };
import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { z } from "zod";
import { FOREIGN_TOOL_ADAPTER_PROGRAM } from "@sweatpants/tool-session/foreign";
import {
  ExecutionDurableEffectRegistryContext,
  ProgramDriverRegistryContext,
  type DurableToolRegistry,
  type ProgramDriverRegistry,
} from "@sweatpants/durable-execution";

import type { ProgramDriverJournal, ProgramDriverJournalStore } from "./program-driver-journal.ts";

export type ProgramCatalogEntry =
  | { kind: "program"; target: string; program: PinnedProgram }
  | {
      kind: "foreign-tool";
      target: string;
      driver: string;
      tool: string;
      durability: ForeignDurability;
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
    kind: z.literal("foreign-tool"),
    target: catalogTextSchema,
    driver: catalogTextSchema,
    tool: catalogTextSchema,
    durability: z.enum([
      "opaque",
      "ephemeral_handle",
      "resumable_handle",
      "server_task",
      "crank_native",
    ]),
  }),
]);
const programCatalogEntriesSchema = z.record(catalogTextSchema, programCatalogEntrySchema);
const pinnedProgramCatalogSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: programCatalogEntriesSchema,
});

export interface LocalProgramHostOptions {
  journalStore: ProgramDriverJournalStore;
  programs: DurableToolRegistry;
  effects: DurableEffectRegistry;
  drivers: ProgramDriverRegistry;
  routeResolver?: (program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>;
  modelSamplingService?: ModelSamplingService;
  effectOutcomeAcknowledger?: DurableEffectOutcomeAcknowledger;
  deliveryWriter?: ProgramDeliveryWriter;
}

export interface OpenLocalProgramRequest {
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  program: PinnedProgram;
  manifest: DurableProgramManifest;
  input: Json;
  catalog: PinnedProgramCatalog;
  route?: ProgramRoute;
}

export interface LocalProgramRun {
  sessionId: string;
  turnId: string;
  taskId: string;
  result: Operation<ProgramRunResult>;
}

export interface LocalProgramHost {
  open(request: OpenLocalProgramRequest): Operation<LocalProgramRun>;
  resume(sessionId: string): Operation<ProgramRunResult>;
  respond(request: {
    sessionId: string;
    taskId: string;
    pullId: string;
    response: ProgramElicitResult;
  }): Operation<ProgramRunResult>;
  cancel(sessionId: string, taskId: string, reason?: string): Operation<void>;
  trace(sessionId: string): Operation<NormalizedProgramTrace>;
}

type AcceptedExecution = {
  route: ProgramRoute;
  executionEpoch: number;
  catalog: PinnedProgramCatalog;
};

export interface LocalProgramActivationScope {
  authority: ProgramDriverJournal["authority"];
  effects: DurableEffectRegistry;
  drivers: ProgramDriverRegistry;
  routeResolver?: (program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>;
  modelSamplingService?: ModelSamplingService;
  effectOutcomeAcknowledger?: DurableEffectOutcomeAcknowledger;
  deliveryWriter?: ProgramDeliveryWriter;
}

/** Installs the protocol-neutral authority scope shared by LocalProgramHost and applications. */
export function* runLocalProgramActivation<T>(
  scope: LocalProgramActivationScope,
  operation: () => Operation<T>,
): Operation<T> {
  const runConfigured = function* (): Operation<T> {
    return yield* ProgramDriverRegistryContext.with(scope.drivers, function* () {
      return yield* withJournalAuthority(scope.authority, function* () {
        return yield* DurableEffectRegistryContext.with(scope.effects, function* () {
          return yield* ExecutionDurableEffectRegistryContext.with(scope.effects, function* () {
            return yield* ProgramRouteResolverContext.with(scope.routeResolver, function* () {
              return yield* DurableEffectOutcomeAcknowledgerContext.with(
                scope.effectOutcomeAcknowledger,
                operation,
              );
            });
          });
        });
      });
    });
  };
  return yield* runWithModelSamplingService(scope.modelSamplingService, function* () {
    return yield* runWithProgramDeliveryWriter(scope.deliveryWriter, runConfigured);
  });
}

/**
 * Creates the protocol-neutral in-process Host composition. ProgramRuntime is
 * still the only crank turner; this object owns identity, authority lookup,
 * exact registries, user responses, cancellation, and trace projection.
 */
export function createLocalProgramHost(options: LocalProgramHostOptions): LocalProgramHost {
  // Process-local ownership is only a churn-avoidance hint. Every reuse is
  // checked against authority state; a replacement Host has an empty map and
  // therefore claims newer fences for the complete active task tree.
  const ownedSessionEpochs = new Map<string, number>();

  function findTool(program: PinnedProgram) {
    return options.programs.get(exactProgramKey(program));
  }

  function verifyLocalProgramRequest(request: OpenLocalProgramRequest): void {
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
      canonicalSnapshot(request.manifest).sha !== canonicalSnapshot(tool.manifest).sha
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
  ): Operation<ProgramRunResult> {
    return yield* runLocalProgramActivation(
      {
        authority: journal.authority,
        drivers: options.drivers,
        effects: options.effects,
        // Always install this wrapper: the no-policy case still has to enforce
        // the accepted catalog before returning the inherited parent route.
        routeResolver: function* (child, parentRoute) {
          assertCatalogDispatch(execution.catalog, child);
          return options.routeResolver
            ? yield* options.routeResolver(child, parentRoute)
            : parentRoute;
        },
        ...(options.modelSamplingService
          ? { modelSamplingService: options.modelSamplingService }
          : {}),
        ...(options.effectOutcomeAcknowledger
          ? { effectOutcomeAcknowledger: options.effectOutcomeAcknowledger }
          : {}),
        ...(options.deliveryWriter ? { deliveryWriter: options.deliveryWriter } : {}),
      },
      function* () {
        return yield* ProgramRuntime.operations.run({
          attach: {
            sessionId,
            taskId,
            program,
            input,
            route: execution.route,
            executionEpoch: execution.executionEpoch,
          },
          executeHostEffects: true,
        });
      },
    );
  }

  function* resumeTask(sessionId: string, requestedTaskId?: string): Operation<ProgramRunResult> {
    const journal = yield* options.journalStore.open(sessionId);
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
    const states = new Map(
      recovery.activeTasks.map((task) => [task.taskId, task.executionEpoch] as const),
    );
    const ownedEpoch = ownedSessionEpochs.get(sessionId);
    const canReuseOwnedEpoch =
      ownedEpoch !== undefined && [...states.values()].every((epoch) => epoch === ownedEpoch);

    let rootExecutionEpoch = canReuseOwnedEpoch ? ownedEpoch : undefined;
    if (!canReuseOwnedEpoch) {
      const targetEpoch = Math.max(0, ...states.values()) + 1;
      for (const task of recovery.activeTasks) {
        let taskEpoch = task.executionEpoch;
        while (taskEpoch < targetEpoch) {
          taskEpoch = (yield* journal.replaceAttachment(
            sessionId,
            task.taskId,
            `local-host-resume:${crypto.randomUUID()}`,
          )).executionEpoch;
        }
        if (task.taskId === recovery.taskId) {
          rootExecutionEpoch = taskEpoch;
        }
      }
    }
    if (rootExecutionEpoch === undefined) {
      throw new CrankError("invalid_journal", "Runnable root was not fenced for recovery");
    }
    ownedSessionEpochs.set(sessionId, rootExecutionEpoch);
    return yield* runTask(journal, sessionId, recovery.taskId, program, recovery.input, {
      ...accepted,
      executionEpoch: rootExecutionEpoch,
    });
  }

  return {
    *open(request): Operation<LocalProgramRun> {
      verifyLocalProgramRequest(request);
      const sessionId = request.sessionId ?? `local-session:${crypto.randomUUID()}`;
      const journal = yield* options.journalStore.open(sessionId);
      const rootCount = yield* journal.rootTaskCount(sessionId);
      const turnId = request.turnId ?? `turn-${rootCount}`;
      const taskId = request.taskId ?? `${turnId}/root`;
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
        audience: "program-runtime",
        catalog: canonicalSnapshot(assertJson(request.catalog)).value,
        catalogDigest: request.catalog.digest,
        route,
      });
      ownedSessionEpochs.set(sessionId, execution.executionEpoch);
      return {
        sessionId,
        turnId,
        taskId,
        result: runTask(journal, sessionId, taskId, request.program, request.input, execution),
      };
    },

    *resume(sessionId): Operation<ProgramRunResult> {
      return yield* resumeTask(sessionId);
    },

    *respond(request): Operation<ProgramRunResult> {
      const journal = yield* options.journalStore.open(request.sessionId);
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
          : { status: "ok", value: canonicalSnapshot(request.response).value };
      if (operation.outcome !== undefined) {
        if (canonicalSnapshot(operation.outcome).sha !== canonicalSnapshot(outcome).sha) {
          throw new CrankError("resolution_conflict", "Elicitation response conflicts");
        }
        return yield* resumeTask(request.sessionId);
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
      return yield* resumeTask(request.sessionId);
    },

    *cancel(sessionId, taskId, reason): Operation<void> {
      const journal = yield* options.journalStore.open(sessionId);
      yield* journal.requestCancellation(sessionId, taskId, reason);
    },

    *trace(sessionId): Operation<NormalizedProgramTrace> {
      const journal = yield* options.journalStore.open(sessionId);
      return normalizeProgramTrace(yield* journal.readJournal(sessionId));
    },
  };
}

export function createPinnedProgramCatalog(
  entries: Readonly<Record<string, ProgramCatalogEntry>>,
): PinnedProgramCatalog {
  const canonicalEntries = programCatalogEntriesSchema.parse(canonicalSnapshot(entries).value);
  return {
    version: 1,
    digest: canonicalSnapshot({ version: 1, entries: canonicalEntries }).sha,
    entries: canonicalEntries,
  };
}

export function verifyPinnedProgramCatalog(catalog: PinnedProgramCatalog): void {
  if (catalog.digest !== canonicalSnapshot({ version: 1, entries: catalog.entries }).sha) {
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

function assertCatalogDispatch(catalog: PinnedProgramCatalog, program: PinnedProgram): void {
  const entries = Object.values(catalog.entries);
  const exact = entries.some(
    (entry) =>
      entry.kind === "program" && exactProgramKey(entry.program) === exactProgramKey(program),
  );
  if (exact) {
    return;
  }

  const foreignAdapter =
    exactProgramKey(program) === exactProgramKey(FOREIGN_TOOL_ADAPTER_PROGRAM) &&
    entries.some((entry) => entry.kind === "foreign-tool");
  if (foreignAdapter) {
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

export function normalizeProgramTrace(
  records: readonly DurableSemanticRecord[],
): NormalizedProgramTrace {
  const tasks = new Map<string, NormalizedProgramTaskTrace>();
  const operationByPull = new Map<string, NormalizedProgramOperationTrace>();
  for (const record of records) {
    const payload = record.payload;
    if (payload.type === "TaskOpened") {
      tasks.set(payload.taskId, {
        taskId: payload.taskId,
        turnId: payload.turnId,
        ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
        ...(payload.parentPullId ? { parentPullId: payload.parentPullId } : {}),
        program: {
          id: payload.programId,
          version: payload.programVersion,
          digest: payload.programDigest,
        },
        acceptedInput: structuredClone(payload.input),
        ...(payload.catalogDigest ? { catalogDigest: payload.catalogDigest } : {}),
        operations: [],
        semanticEmissions: [],
        cancellations: [],
      });
      continue;
    }
    if (payload.type === "PullRequested") {
      const operation = {
        actionIndex: payload.actionIndex,
        pullId: payload.pullId,
        descriptor: assertJson(structuredClone(payload.descriptor)),
      };
      tasks.get(payload.taskId)?.operations.push(operation);
      operationByPull.set(payload.pullId, operation);
      continue;
    }
    if (payload.type === "PullResolved") {
      const operation = operationByPull.get(payload.pullId);
      if (operation) {
        operation.outcome = structuredClone(payload.outcome);
      }
      continue;
    }
    if (payload.type === "DurableEmission") {
      tasks
        .get(payload.taskId)
        ?.semanticEmissions.push(assertJson(structuredClone(payload.descriptor)));
      continue;
    }
    if (payload.type === "CancellationRequested") {
      tasks.get(payload.taskId)?.cancellations.push({
        taskId: payload.taskId,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      });
      continue;
    }
    if (payload.type === "TaskClosed") {
      const task = tasks.get(payload.taskId);
      if (task) {
        task.terminal = structuredClone(payload.outcome);
      }
    }
  }
  return { version: 1, tasks: [...tasks.values()] };
}

function outcomeToRunResult(outcome: OperationOutcome): ProgramRunResult {
  return outcome.status === "ok"
    ? { state: "completed", value: outcome.value }
    : outcome.status === "cancelled"
      ? { state: "cancelled" }
      : { state: "failed", error: outcome.error };
}
