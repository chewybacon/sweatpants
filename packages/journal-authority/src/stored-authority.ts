import {
  assertJson,
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import { CrankError, type DurableReference } from "@sweatpants/durable-execution";
import { call, type Operation } from "effection";
import type { DurableSchemaRegistry } from "./schema-registry.ts";
import type {
  ExecutionControl,
  ExecutionStore,
  PrivateSegmentPointer,
  StoredPrivateSegment,
} from "./store.ts";
import { runExecutionCommitLoop } from "./commit-loop.ts";
import {
  DEFAULT_PRIVATE_SEGMENT_TARGET,
  segmentPrivateEntries,
  type PrivateSegmentTarget,
} from "./segmentation.ts";
import {
  InMemoryDurableJournalAuthority,
  parseDurableAuthoritySnapshot,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  type OpenDurableTaskRequest,
} from "./durable-authority.ts";
import type {
  AppendEmissionRequest,
  BindRestoreFrontierRequest,
  BindRestoreFrontierResult,
  CancellationAcknowledgement,
  ClaimActivationRequest,
  ClaimActivationResult,
  CompleteTaskRequest,
  ConsumeRestoreTicketRequest,
  ConsumeRestoreTicketResult,
  DurableCancellationState,
  DurableOperationState,
  DurableTaskExecutionState,
  DurableTaskRecoveryState,
  EmissionReceipt,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  PrepareProgramRestoreRequest,
  PreparedProgramRestore,
  RecoverableSession,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  RenewActivationRequest,
  RenewActivationResult,
  RestoredFrontierProof,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "./durable-authority-types.ts";
import type { CapabilityKeyring } from "./capabilities.ts";
import type { ProgramStep } from "@sweatpants/durable-execution";

export interface StoredDurableJournalAuthorityOptions {
  readonly journalId: string;
  readonly journalIncarnation?: string;
  readonly keyring: CapabilityKeyring;
  readonly now?: () => number;
  readonly maxOutcomeBytes?: number;
  readonly schemaRegistry?: DurableSchemaRegistry;
  /** Test/import boundary for an already parsed current-format snapshot. */
  readonly initialSnapshot?: DurableAuthoritySnapshot;
  /** Private journal/replay segment targets. */
  readonly privateSegmentTarget?: PrivateSegmentTarget;
}

export interface StoredDurableJournalAuthority {
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  /** Returns authority-owned placement and catalog recovery state. */
  taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  /** Returns the canonical parsed input accepted for one task. */
  taskInput(sessionId: string, taskId: string): Operation<Json>;
  /** Selects active root work or its terminal value without exposing the journal. */
  taskRecoveryState(
    sessionId: string,
    requestedTaskId?: string,
  ): Operation<DurableTaskRecoveryState>;
  rootTaskCount(sessionId: string): Operation<number>;
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
  /** Lists exact schema digests referenced by nonterminal tasks. */
  nonterminalSchemaDigests(): Operation<string[]>;
  /** Clears the runnable marker when an accepted activation starts. */
  recoverableSessions(): Operation<RecoverableSession[]>;
  claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult>;
  renewActivation(request: RenewActivationRequest): Operation<RenewActivationResult>;
  releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult>;
  issueRestoreTicket(request: IssueRestoreTicketRequest): Operation<IssueRestoreTicketResult>;
  prepareProgramRestore(request: PrepareProgramRestoreRequest): Operation<PreparedProgramRestore>;
  bindRestoreFrontier(request: BindRestoreFrontierRequest): Operation<BindRestoreFrontierResult>;
  consumeRestoreTicket(request: ConsumeRestoreTicketRequest): Operation<ConsumeRestoreTicketResult>;
  /** Reads durable cancellation lifecycle state. */
  cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState>;
  /** Starts one-shot authored cancellation unwind. */
  beginCancellationUnwind(
    sessionId: string,
    taskId: string,
    restoredFrontier?: { readonly proof: RestoredFrontierProof; readonly step: ProgramStep },
  ): Operation<DurableCancellationState>;
  /** Binds current program authority under Redis CAS fencing. */
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  /** Idempotently allocates a deterministic child task. */
  ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
  /** Atomically reserves an operation before host dispatch. */
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  /** Atomically commits a capability-authorized outcome. */
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  /** Atomically appends an ordered durable emission. */
  emit(request: AppendEmissionRequest): Operation<EmissionReceipt>;
  /** Atomically closes a task after output validation. */
  complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt>;
  /** Opens one pinned task exactly once. */
  openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
  /** Fences an old attachment and advances its execution epoch. */
  replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    audience?: string,
  ): Operation<{ executionEpoch: number; programCapability: string }>;
  /** Idempotently records logical task cancellation. */
  requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): Operation<CancellationAcknowledgement>;
  /** Detaches an in-flight attempt and applies its declared indeterminate policy. */
  detachAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    reason?: string,
  ): Operation<void>;
  /** Revokes an attempt that can no longer resolve. */
  abandonAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    attemptId: string,
    reason?: string,
  ): Operation<void>;
  /** Orphans a task whose pinned program is unavailable or corrupt. */
  forceOrphan(
    sessionId: string,
    taskId: string,
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged",
  ): Operation<void>;
  /** Returns the current resolver capability for an existing pending pull. */
  resolutionCapability(sessionId: string, taskId: string, pullId: string): Operation<string>;
  /** Reads a parsed defensive semantic journal snapshot. */
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  /** Reads one root tree without scanning completed sibling Turns. */
  readTaskJournal(sessionId: string, rootTaskId: string): Operation<DurableSemanticRecord[]>;
  /** Reads deterministic runnable session IDs. */
  runnableSessions(): Operation<string[]>;
  /** Exports the parsed authority state for explicit test/state-transfer boundaries. */
  exportSnapshot(): Operation<DurableAuthoritySnapshot>;
}

export function createStoredDurableJournalAuthority(
  store: ExecutionStore,
  options: StoredDurableJournalAuthorityOptions,
): StoredDurableJournalAuthority {
  const executionId = `authority:${options.journalId}`;
  const empty: DurableAuthoritySnapshot = {
    version: 4,
    tasks: [],
    records: [],
    runnable: [],
    nonce: 0,
    activationLeases: [],
    lastActivationEpochBySession: [],
    taskRevisions: [],
    restoreNonces: [],
    restoreFrontierDigests: [],
    consecutiveRestoreStales: [],
    activationNotBeforeMs: [],
  };

  function authority(snapshot: DurableAuthoritySnapshot): InMemoryDurableJournalAuthority {
    return new InMemoryDurableJournalAuthority({
      journalId: options.journalId,
      keyring: options.keyring,
      snapshot,
      ...(options.journalIncarnation !== undefined
        ? { journalIncarnation: options.journalIncarnation }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.maxOutcomeBytes !== undefined
        ? { maxOutcomeBytes: options.maxOutcomeBytes }
        : {}),
      ...(options.schemaRegistry !== undefined ? { schemaRegistry: options.schemaRegistry } : {}),
    });
  }

  interface AuthorityControl {
    readonly kind: "authority-control";
    readonly snapshot: DurableReference;
    readonly journalHead: PrivateSegmentPointer | null;
    readonly replayHead: PrivateSegmentPointer | null;
  }

  interface LoadedAuthority {
    readonly control: ExecutionControl | null;
    readonly snapshot: DurableAuthoritySnapshot;
    readonly authorityControl: AuthorityControl | null;
  }

  function parsePrivatePointer(value: unknown): PrivateSegmentPointer | null {
    if (value === null) return null;
    if (
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>)["segmentId"] !== "string" ||
      typeof (value as Record<string, unknown>)["lastSequence"] !== "string"
    ) {
      throw new CrankError("invalid_journal", "Stored authority private pointer is invalid");
    }
    return {
      segmentId: (value as Record<string, string>)["segmentId"]!,
      lastSequence: (value as Record<string, string>)["lastSequence"]!,
    };
  }

  function parseAuthorityControl(value: Json): AuthorityControl {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CrankError("invalid_journal", "Stored authority control record is invalid");
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate["kind"] !== "authority-control" ||
      candidate["snapshot"] === null ||
      typeof candidate["snapshot"] !== "object"
    ) {
      throw new CrankError("invalid_journal", "Stored authority control record is invalid");
    }
    const snapshot = candidate["snapshot"] as Record<string, unknown>;
    if (typeof snapshot["id"] !== "string") {
      throw new CrankError("invalid_journal", "Stored authority snapshot pointer is invalid");
    }
    return {
      kind: "authority-control",
      snapshot: snapshot as unknown as DurableReference,
      journalHead: parsePrivatePointer(candidate["journalHead"]),
      replayHead: parsePrivatePointer(candidate["replayHead"]),
    };
  }

  function parseJournalCollections(
    entries: readonly Json[],
  ): Array<[string, DurableSemanticRecord[]]> {
    const grouped = new Map<string, Json[]>();
    for (const entry of entries) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry["sessionId"] !== "string"
      ) {
        throw new CrankError("invalid_journal", "Stored authority journal entry is invalid");
      }
      const sessionId = entry["sessionId"];
      const sessionEntries = grouped.get(sessionId) ?? [];
      sessionEntries.push(entry);
      grouped.set(sessionId, sessionEntries);
    }
    return [...grouped.entries()].map(([sessionId, sessionEntries]) => {
      const parsed = parseDurableAuthoritySnapshot(
        JSON.stringify({ ...empty, records: [[sessionId, sessionEntries]] }),
      );
      return parsed.records[0] ?? [sessionId, []];
    });
  }

  function* load(supplied?: ExecutionControl | null): Operation<LoadedAuthority> {
    const current = supplied === undefined ? yield* store.loadControl(executionId) : supplied;
    if (!current) {
      return {
        control: null,
        snapshot: options.initialSnapshot ?? empty,
        authorityControl: null,
      };
    }
    const authorityControl = parseAuthorityControl(current.control);
    const payload = yield* store.getObject({ objectId: authorityControl.snapshot.id });
    if (!payload || payload.body instanceof Uint8Array) {
      throw new CrankError("invalid_journal", "Stored authority snapshot payload is unavailable");
    }
    if (payload.lifetimeScope === "execution" && payload.scopeOwnerId !== executionId) {
      throw new CrankError(
        "invalid_journal",
        "Stored authority snapshot is outside execution scope",
      );
    }
    if (payload.body === null || typeof payload.body !== "object" || Array.isArray(payload.body)) {
      throw new CrankError("invalid_journal", "Stored authority snapshot payload is invalid");
    }
    // The mutable authority object stores topology and frontiers only. The
    // complete semantic record collection is reconstructed from immutable
    // journal segments before the authority is handed to the in-memory engine.
    const base = parseDurableAuthoritySnapshot(JSON.stringify({ ...payload.body, records: [] }));
    const journal = authorityControl.journalHead
      ? yield* store.readJournal({
          executionId,
          taskId: "authority",
          head: authorityControl.journalHead,
        })
      : null;
    const entries = journal
      ? yield* call(async () => {
          const values: Json[] = [];
          for await (const chunk of journal) values.push(...chunk);
          return values;
        })
      : [];
    return {
      control: current,
      authorityControl,
      snapshot: {
        ...base,
        records: parseJournalCollections(entries),
      },
    };
  }

  function control(
    snapshot: DurableReference,
    journalHead: PrivateSegmentPointer | null,
    replayHead: PrivateSegmentPointer | null,
  ): Omit<ExecutionControl, "controlRevision" | "updatedAt"> {
    return {
      executionId,
      ownerFence: "0",
      status: "parked",
      rootTaskId: "authority",
      stopGeneration: "0",
      requestedDisposition: null,
      control: assertJson({
        kind: "authority-control",
        snapshot,
        journalHead,
        replayHead,
      }),
    };
  }

  function makeSegments(
    taskId: string,
    previous: PrivateSegmentPointer | null,
    entries: readonly Json[],
    createdAt: number,
  ): StoredPrivateSegment[] {
    if (entries.length === 0) return [];
    const target = options.privateSegmentTarget ?? DEFAULT_PRIVATE_SEGMENT_TARGET;
    const segments: StoredPrivateSegment[] = [];
    let cursor = previous;
    for (const batch of segmentPrivateEntries(entries, target)) {
      const encoded = canonicalSnapshot(batch.entries);
      const first = cursor === null ? 1n : BigInt(cursor.lastSequence) + 1n;
      const last = first + BigInt(batch.entries.length - 1);
      const contentHash = sha256(encoded.canonical);
      const segment: StoredPrivateSegment = {
        segmentId: stableTupleHash([executionId, taskId, first.toString(10), contentHash]),
        executionId,
        taskId,
        previous: cursor,
        firstSequence: first.toString(10),
        lastSequence: last.toString(10),
        entries: batch.entries,
        contentHash,
        encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
        createdAt,
      };
      segments.push(segment);
      cursor = { segmentId: segment.segmentId, lastSequence: segment.lastSequence };
    }
    return segments;
  }

  function* mutate<T>(
    operation: (value: InMemoryDurableJournalAuthority) => Operation<T>,
  ): Operation<T> {
    return yield* runExecutionCommitLoop(store, executionId, function* (current) {
      const loaded = yield* load(current);
      const value = authority(loaded.snapshot);
      const result = yield* operation(value);
      const exported = value.exportSnapshot();
      const compacted = compactAuthoritySnapshot(exported);
      if (canonicalSnapshot(compacted).sha === canonicalSnapshot(loaded.snapshot).sha) {
        return { status: "return", result };
      }
      const priorEventIds = loaded.authorityControl
        ? new Set(
            loaded.snapshot.records.flatMap(([, records]) =>
              records.map((record) => record.eventId),
            ),
          )
        : new Set<string>();
      const appended = exported.records.flatMap(([, records]) =>
        records.filter((record) => !priorEventIds.has(record.eventId)),
      );
      const retainedEventIds = new Set(
        compacted.records.flatMap(([, records]) => records.map((record) => record.eventId)),
      );
      const evicted = exported.records.flatMap(([, records]) =>
        records.filter((record) => !retainedEventIds.has(record.eventId)),
      );
      const journal = makeSegments(
        "authority",
        loaded.authorityControl?.journalHead ?? null,
        appended.map((record) => assertJson(record)),
        options.now?.() ?? Date.now(),
      );
      const replay = makeSegments(
        "authority-archive",
        loaded.authorityControl?.replayHead ?? null,
        evicted.map((record) => assertJson(record)),
        options.now?.() ?? Date.now(),
      );
      const snapshot = assertJson({ ...compacted, records: [] });
      const encoded = canonicalSnapshot(snapshot);
      const snapshotId = stableTupleHash([executionId, "authority-snapshot", encoded.sha]);
      yield* store.putObject({
        objectId: snapshotId,
        lifetimeScope: "execution",
        scopeOwnerId: executionId,
        objectKind: "authority-snapshot",
        contentHash: encoded.sha,
        byteLength: new TextEncoder().encode(encoded.canonical).byteLength,
        body: encoded.value,
        createdAt: options.now?.() ?? Date.now(),
      });
      return {
        status: "commit",
        next: control(
          {
            id: snapshotId,
            byteLength: new TextEncoder().encode(encoded.canonical).byteLength,
            version: "1",
            integrity: { algorithm: "sha256", value: encoded.sha },
          },
          journal.at(-1)
            ? {
                segmentId: journal.at(-1)!.segmentId,
                lastSequence: journal.at(-1)!.lastSequence,
              }
            : (loaded.authorityControl?.journalHead ?? null),
          replay.at(-1)
            ? {
                segmentId: replay.at(-1)!.segmentId,
                lastSequence: replay.at(-1)!.lastSequence,
              }
            : (loaded.authorityControl?.replayHead ?? null),
        ),
        ...(journal.length > 0 ? { journalSegments: journal } : {}),
        ...(replay.length > 0 ? { replaySegments: replay } : {}),
        result,
      };
    });
  }

  function* read<T>(select: (value: InMemoryDurableJournalAuthority) => T): Operation<T> {
    const loaded = yield* load();
    return select(authority(loaded.snapshot));
  }

  function parseRecords(sessionId: string, entries: readonly Json[]): DurableSemanticRecord[] {
    const records = entries.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry["sessionId"] === sessionId,
    );
    const parsed = parseDurableAuthoritySnapshot(
      JSON.stringify({ ...empty, records: [[sessionId, records]] }),
    );
    return parsed.records[0]?.[1] ?? [];
  }

  function* readJournalRecords(sessionId: string): Operation<DurableSemanticRecord[]> {
    const loaded = yield* load();
    const current = loaded.authorityControl?.journalHead
      ? yield* store.readJournal({
          executionId,
          taskId: "authority",
          head: loaded.authorityControl.journalHead,
        })
      : null;
    const currentEntries = current
      ? yield* call(async () => {
          const values: Json[] = [];
          for await (const chunk of current) values.push(...chunk);
          return values;
        })
      : [];
    const journalRecords = parseRecords(sessionId, currentEntries);
    if (journalRecords.length > 0) return journalRecords;
    return (
      loaded.snapshot.records.find(([storedSessionId]) => storedSessionId === sessionId)?.[1] ?? []
    );
  }

  return {
    journalIdentity() {
      return {
        id: options.journalId,
        incarnation: options.journalIncarnation ?? "1",
      };
    },
    *taskExecutionState(sessionId, taskId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).taskExecutionState(sessionId, taskId);
    },
    *taskInput(sessionId, taskId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).taskInput(sessionId, taskId);
    },
    *taskRecoveryState(sessionId, requestedTaskId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).taskRecoveryState(sessionId, requestedTaskId);
    },
    *rootTaskCount(sessionId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).rootTaskCount(sessionId);
    },
    *operationState(sessionId, taskId, pullId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).operationState(sessionId, taskId, pullId);
    },
    *nonterminalSchemaDigests() {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).nonterminalSchemaDigests();
    },
    *recoverableSessions() {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).recoverableSessions();
    },
    *claimActivation(request) {
      return yield* mutate((value) => value.claimActivation(request));
    },
    *renewActivation(request) {
      return yield* mutate((value) => value.renewActivation(request));
    },
    *releaseActivation(request) {
      return yield* mutate((value) => value.releaseActivation(request));
    },
    *issueRestoreTicket(request) {
      return yield* mutate((value) => value.issueRestoreTicket(request));
    },
    *prepareProgramRestore(request) {
      return yield* mutate((value) => value.prepareProgramRestore(request));
    },
    *bindRestoreFrontier(request) {
      return yield* mutate((value) => value.bindRestoreFrontier(request));
    },
    *consumeRestoreTicket(request) {
      return yield* mutate((value) => value.consumeRestoreTicket(request));
    },
    *cancellationState(sessionId, taskId) {
      return yield* mutate((value) => value.cancellationState(sessionId, taskId));
    },
    *beginCancellationUnwind(sessionId, taskId, restoredFrontier) {
      return yield* mutate((value) =>
        value.beginCancellationUnwind(sessionId, taskId, restoredFrontier),
      );
    },
    *bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch) {
      return yield* mutate((value) =>
        value.bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch),
      );
    },
    *openTask(request) {
      return yield* mutate((value) => value.openTask(request));
    },
    *ensureChildTask(request) {
      return yield* mutate((value) => value.ensureChildTask(request));
    },
    *replaceAttachment(sessionId, taskId, attachmentId, audience) {
      return yield* mutate((value) =>
        value.replaceAttachment(sessionId, taskId, attachmentId, audience),
      );
    },
    *reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
      return yield* mutate((value) => value.reserve(request));
    },
    *resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
      return yield* mutate((value) => value.resolve(request));
    },
    *emit(request: AppendEmissionRequest): Operation<EmissionReceipt> {
      return yield* mutate((value) => value.emit(request));
    },
    *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
      return yield* mutate((value) => value.complete(request));
    },
    *requestCancellation(sessionId, taskId, reason, commandId) {
      return yield* mutate((value) =>
        value.requestCancellation(sessionId, taskId, reason, commandId),
      );
    },
    *detachAttempt(sessionId, taskId, pullId, reason) {
      yield* mutate((value) => value.detachAttempt(sessionId, taskId, pullId, reason));
    },
    *abandonAttempt(sessionId, taskId, pullId, attemptId, reason) {
      yield* mutate((value) => value.abandonAttempt(sessionId, taskId, pullId, attemptId, reason));
    },
    *forceOrphan(sessionId, taskId, reason) {
      yield* mutate((value) => value.forceOrphan(sessionId, taskId, reason));
    },
    *resolutionCapability(sessionId, taskId, pullId) {
      return yield* read((value) => value.resolutionCapability(sessionId, taskId, pullId));
    },
    *readJournal(sessionId) {
      return yield* readJournalRecords(sessionId);
    },
    *readTaskJournal(sessionId, rootTaskId) {
      const records = yield* readJournalRecords(sessionId);
      const taskIds = new Set([rootTaskId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) {
          if (
            record.payload.type === "TaskOpened" &&
            record.payload.parentTaskId &&
            taskIds.has(record.payload.parentTaskId) &&
            !taskIds.has(record.payload.taskId)
          ) {
            taskIds.add(record.payload.taskId);
            changed = true;
          }
        }
      }
      return records.filter((record) => taskIds.has(record.payload.taskId));
    },
    *runnableSessions() {
      return yield* read((value) => value.runnableSessions());
    },
    *exportSnapshot() {
      return yield* read((value) => value.exportSnapshot());
    },
  };
}

/** Retains active trees or only the latest terminal tree for each Session. */
function compactAuthoritySnapshot(snapshot: DurableAuthoritySnapshot): DurableAuthoritySnapshot {
  const rootsBySession = new Map<string, typeof snapshot.tasks>();
  for (const task of snapshot.tasks) {
    if (task.parentTaskId) continue;
    rootsBySession.set(task.sessionId, [...(rootsBySession.get(task.sessionId) ?? []), task]);
  }
  const retained = new Set<string>();
  for (const roots of rootsBySession.values()) {
    const active = roots.filter((root) => root.status === "active");
    for (const root of active.length > 0 ? active : roots.slice(-1)) retained.add(root.taskId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of snapshot.tasks) {
      if (task.parentTaskId && retained.has(task.parentTaskId) && !retained.has(task.taskId)) {
        retained.add(task.taskId);
        changed = true;
      }
    }
  }
  return {
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => retained.has(task.taskId)),
    records: snapshot.records.map(([sessionId, records]) => [
      sessionId,
      records.filter((record) => retained.has(record.payload.taskId)),
    ]),
  };
}
