import type { Operation } from "effection";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  ModelSamplingRouterContext,
  ModelSamplingOutcomeAcknowledgerContext,
  ProgramDeliveryWriterContext,
  canonicalSnapshot,
  stableProgramAttachmentId,
  validateDurableEffectBindings,
  type DurableEffectRegistry,
  type DurableProgramManifest,
  type DurableSemanticRecord,
  type DurableToolRegistry,
  type ForeignDurability,
  type Json,
  type OperationOutcome,
  type ModelSamplingRouter,
  type ModelSamplingOutcomeAcknowledger,
  type ProgramDeliveryWriter,
  type PinnedProgram,
  type ProgramDriverRegistry,
  type ProgramRoute,
  type ProgramRunResult,
  type WireElicitResultJson,
  CrankError,
} from "@sweatpants/session-contract";

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

export interface NormalizedProgramOperationTrace {
  actionIndex: number;
  pullId: string;
  descriptor: Json;
  outcome?: OperationOutcome;
}

export interface NormalizedProgramTaskTrace {
  taskId: string;
  turnId: string;
  parentTaskId?: string;
  parentPullId?: string;
  program: PinnedProgram;
  acceptedInput: Json;
  operations: NormalizedProgramOperationTrace[];
  semanticEmissions: Json[];
  cancellations: Json[];
  terminal?: OperationOutcome;
}

export interface NormalizedProgramTrace {
  version: 1;
  tasks: NormalizedProgramTaskTrace[];
}

export interface LocalProgramHostOptions {
  journalStore: ProgramDriverJournalStore;
  programs: DurableToolRegistry;
  effects: DurableEffectRegistry;
  drivers: ProgramDriverRegistry;
  routeResolver?: (program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>;
  modelSamplingRouter?: ModelSamplingRouter;
  modelSamplingOutcomeAcknowledger?: ModelSamplingOutcomeAcknowledger;
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
    response: WireElicitResultJson;
  }): Operation<ProgramRunResult>;
  cancel(sessionId: string, taskId: string, reason?: string): Operation<void>;
  trace(sessionId: string): Operation<NormalizedProgramTrace>;
}

type Execution = {
  route: ProgramRoute;
  executionEpoch: number;
};

export interface LocalProgramActivationScope {
  authority: ProgramDriverJournal["authority"];
  effects: DurableEffectRegistry;
  drivers: ProgramDriverRegistry;
  routeResolver?: (program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>;
  modelSamplingRouter?: ModelSamplingRouter;
  modelSamplingOutcomeAcknowledger?: ModelSamplingOutcomeAcknowledger;
  deliveryWriter?: ProgramDeliveryWriter;
}

/** Installs the protocol-neutral authority scope shared by LocalProgramHost and applications. */
export function runLocalProgramActivation<T>(
  scope: LocalProgramActivationScope,
  operation: () => Operation<T>,
): Operation<T> {
  return ProgramDriverRegistryContext.with(scope.drivers, function* () {
    return yield* JournalAuthorityContext.with(scope.authority, function* () {
      return yield* DurableEffectRegistryContext.with(scope.effects, function* () {
        return yield* ProgramRouteResolverContext.with(scope.routeResolver, function* () {
          return yield* ModelSamplingRouterContext.with(scope.modelSamplingRouter, function* () {
            return yield* ModelSamplingOutcomeAcknowledgerContext.with(
              scope.modelSamplingOutcomeAcknowledger,
              function* () {
                return yield* ProgramDeliveryWriterContext.with(scope.deliveryWriter, operation);
              },
            );
          });
        });
      });
    });
  });
}

/**
 * Creates the protocol-neutral in-process Host composition. ProgramRuntime is
 * still the only crank turner; this object owns identity, authority lookup,
 * exact registries, user responses, cancellation, and trace projection.
 */
export function createLocalProgramHost(options: LocalProgramHostOptions): LocalProgramHost {
  const executions = new Map<string, Execution>();
  let nextSession = 0;

  function executionKey(sessionId: string, taskId: string): string {
    return `${sessionId}\u0000${taskId}`;
  }

  function findTool(program: PinnedProgram) {
    return options.programs.get(`${program.id}@${program.version}#${program.digest}`);
  }

  function validateProgram(request: OpenLocalProgramRequest): void {
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
    validateCatalog(request.catalog);
    validateDurableEffectBindings(Object.values(request.manifest.effects), options.effects);
  }

  function* runTask(
    journal: ProgramDriverJournal,
    sessionId: string,
    taskId: string,
    program: PinnedProgram,
    input: Json,
    execution: Execution,
  ): Operation<ProgramRunResult> {
    return yield* runLocalProgramActivation(
      {
        authority: journal.authority,
        drivers: options.drivers,
        effects: options.effects,
        ...(options.routeResolver ? { routeResolver: options.routeResolver } : {}),
        ...(options.modelSamplingRouter
          ? { modelSamplingRouter: options.modelSamplingRouter }
          : {}),
        ...(options.modelSamplingOutcomeAcknowledger
          ? { modelSamplingOutcomeAcknowledger: options.modelSamplingOutcomeAcknowledger }
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
    const records = yield* journal.readJournal(sessionId);
    const opened = selectRunnableTask(records, requestedTaskId);
    if (!opened) {
      const terminal = requestedTaskId
        ? terminalOutcome(records, requestedTaskId)
        : latestRootTerminal(records);
      if (terminal) return outcomeToRunResult(terminal);
      throw new CrankError("unknown_target", "No runnable program task in session");
    }
    const program = {
      id: opened.programId,
      version: opened.programVersion,
      digest: opened.programDigest,
    };
    if (!findTool(program)) {
      throw new CrankError("program_version_unavailable", "Accepted program is unavailable");
    }
    const execution = executions.get(executionKey(sessionId, opened.taskId)) ?? {
      route: { driverKind: "generator" },
      executionEpoch: 1,
    };
    return yield* runTask(journal, sessionId, opened.taskId, program, opened.input, execution);
  }

  return {
    *open(request): Operation<LocalProgramRun> {
      validateProgram(request);
      const sessionId = request.sessionId ?? `local-session-${++nextSession}`;
      const journal = yield* options.journalStore.open(sessionId);
      const existing = yield* journal.readJournal(sessionId);
      const rootCount = existing.filter(
        (record) => record.payload.type === "TaskOpened" && !record.payload.parentTaskId,
      ).length;
      const turnId = request.turnId ?? `turn-${rootCount}`;
      const taskId = request.taskId ?? `${turnId}/root`;
      const route = request.route ?? { driverKind: "generator" };
      const execution = { route, executionEpoch: 1 };
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
      });
      executions.set(executionKey(sessionId, taskId), execution);
      return {
        sessionId,
        turnId,
        taskId,
        result: runTask(
          journal,
          sessionId,
          taskId,
          request.program,
          request.input,
          execution,
        ),
      };
    },

    *resume(sessionId): Operation<ProgramRunResult> {
      return yield* resumeTask(sessionId);
    },

    *respond(request): Operation<ProgramRunResult> {
      const journal = yield* options.journalStore.open(request.sessionId);
      const records = yield* journal.readJournal(request.sessionId);
      const pending = records.find(
        (record) =>
          record.payload.type === "PullRequested" &&
          record.payload.taskId === request.taskId &&
          record.payload.pullId === request.pullId &&
          record.payload.descriptor.kind === "elicit",
      );
      if (!pending || pending.payload.type !== "PullRequested" || pending.payload.descriptor.kind !== "elicit") {
        throw new CrankError("unknown_target", "No matching pending elicitation");
      }
      const outcome: OperationOutcome =
        request.response.action === "cancel"
          ? { status: "cancelled" }
          : { status: "ok", value: canonicalSnapshot(request.response).value };
      const resolution = yield* journal.resolvePending({
        sessionId: request.sessionId,
        taskId: request.taskId,
        pullId: request.pullId,
        audience: `user:${pending.payload.descriptor.key}`,
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
  const canonicalEntries = canonicalSnapshot(entries).value as Record<string, ProgramCatalogEntry>;
  return {
    version: 1,
    digest: canonicalSnapshot({ version: 1, entries: canonicalEntries }).sha,
    entries: canonicalEntries,
  };
}

export function validateCatalog(catalog: PinnedProgramCatalog): void {
  if (
    catalog.version !== 1 ||
    catalog.digest !== canonicalSnapshot({ version: 1, entries: catalog.entries }).sha
  ) {
    throw new CrankError("invalid_manifest", "Program catalog digest differs from entries");
  }
  for (const [target, entry] of Object.entries(catalog.entries)) {
    if (!target || target !== entry.target) {
      throw new CrankError("invalid_manifest", "Program catalog target differs from its key");
    }
  }
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
        descriptor: structuredClone(payload.descriptor) as unknown as Json,
      };
      tasks.get(payload.taskId)?.operations.push(operation);
      operationByPull.set(payload.pullId, operation);
      continue;
    }
    if (payload.type === "PullResolved") {
      const operation = operationByPull.get(payload.pullId);
      if (operation) operation.outcome = structuredClone(payload.outcome);
      continue;
    }
    if (payload.type === "DurableEmission") {
      tasks.get(payload.taskId)?.semanticEmissions.push(
        structuredClone(payload.descriptor) as unknown as Json,
      );
      continue;
    }
    if (payload.type === "CancellationRequested") {
      tasks.get(payload.taskId)?.cancellations.push(structuredClone(payload) as unknown as Json);
      continue;
    }
    if (payload.type === "TaskClosed") {
      const task = tasks.get(payload.taskId);
      if (task) task.terminal = structuredClone(payload.outcome);
    }
  }
  return { version: 1, tasks: [...tasks.values()] };
}

function selectRunnableTask(records: readonly DurableSemanticRecord[], requestedTaskId?: string) {
  const closed = new Set(
    records.flatMap((record) =>
      record.payload.type === "TaskClosed" ? [record.payload.taskId] : [],
    ),
  );
  const opened = records.flatMap((record) =>
    record.payload.type === "TaskOpened" &&
    !closed.has(record.payload.taskId) &&
    (!requestedTaskId || record.payload.taskId === requestedTaskId)
      ? [record.payload]
      : [],
  );
  return opened.at(-1);
}

function terminalOutcome(records: readonly DurableSemanticRecord[], taskId: string) {
  const record = [...records]
    .reverse()
    .find(
      (candidate) =>
        candidate.payload.type === "TaskClosed" && candidate.payload.taskId === taskId,
    );
  return record?.payload.type === "TaskClosed" ? record.payload.outcome : undefined;
}

function latestRootTerminal(records: readonly DurableSemanticRecord[]) {
  const roots = records.flatMap((record) =>
    record.payload.type === "TaskOpened" && !record.payload.parentTaskId
      ? [record.payload.taskId]
      : [],
  );
  return roots.length ? terminalOutcome(records, roots.at(-1)!) : undefined;
}

function outcomeToRunResult(outcome: OperationOutcome): ProgramRunResult {
  return outcome.status === "ok"
    ? { state: "completed", value: outcome.value }
    : outcome.status === "cancelled"
      ? { state: "cancelled" }
      : { state: "failed", error: outcome.error };
}
