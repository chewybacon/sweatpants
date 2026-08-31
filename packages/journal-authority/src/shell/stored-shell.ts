import {
  assertJson,
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import { CrankError, type DurableReference } from "@sweatpants/durable-execution";
import { hasLiveDurablePull, signalLiveDurablePull } from "@sweatpants/durable-effects/runtime";
import { call, type Operation } from "effection";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "../contract/schema-registry.ts";
import type {
  ExecutionControl,
  ExecutionStore,
  PrivateSegmentPointer,
  StoredPrivateSegment,
} from "../store/store.ts";
import { runExecutionCommitLoop } from "../store/commit-loop.ts";
import {
  DEFAULT_PRIVATE_SEGMENT_TARGET,
  segmentPrivateEntries,
  type PrivateSegmentTarget,
} from "../store/segmentation.ts";
import { parseDurableAuthoritySnapshot } from "../store/snapshot-codec.ts";
import type {
  DecisionStageDiagnostic,
  DurableAuthoritySnapshot,
} from "../state/authority-snapshot.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";
import { verifyResolutionCapability, type CapabilityKeyring } from "../contract/capabilities.ts";
import type {
  AuthorityCommand,
  AuthorityJournalContract,
  AuthorityQuery,
  AuthorityState,
  AuthoritySnapshotContract,
  CommandResult,
  JournalAuthorityContract,
  KernelContext,
  KernelTransition,
  QueryResult,
} from "../contract/authority-contract.ts";
import {
  authorityStateFromSnapshot,
  snapshotFromAuthorityState,
} from "../state/authority-state.ts";
import { decideAuthorityTransition } from "../decisions/decision-pipeline.ts";
import { queryAuthorityState } from "../decisions/authority-decisions.ts";
import { structuralCommandSessionId } from "../contract/authority-command-address.ts";

export interface StoredJournalAuthorityOptions {
  readonly journalId: string;
  readonly journalIncarnation?: string;
  readonly keyring: CapabilityKeyring;
  readonly now?: () => number;
  readonly maxOutcomeBytes?: number;
  readonly schemaRegistry?: DurableSchemaRegistry;
  readonly decisionDiagnostics?: (diagnostic: DecisionStageDiagnostic) => void;
  /** Test/import boundary for an already parsed current-format snapshot. */
  readonly initialSnapshot?: DurableAuthoritySnapshot;
  /** Private journal/replay segment targets. */
  readonly privateSegmentTarget?: PrivateSegmentTarget;
  /**
   * The embedding's persisted-data directory, named verbatim by the reset
   * failure when stored data cannot be parsed under the current schema
   * (REQ-012: hard-fail with an actionable reset message; no migration).
   */
  readonly dataDirectory?: string;
}

export interface StoredShellDrivers {
  readonly authority: JournalAuthorityContract;
  readonly journal: AuthorityJournalContract;
  readonly snapshot: AuthoritySnapshotContract;
}

export function createStoredShellDrivers(
  store: ExecutionStore,
  options: StoredJournalAuthorityOptions,
): StoredShellDrivers {
  const executionId = `authority:${options.journalId}`;
  const empty: DurableAuthoritySnapshot = { version: 1, sessions: [], nextNonce: 0, records: [] };

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

  function resetFailure(operation: string, record: string, cause: unknown): CrankError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const reset = options.dataDirectory
      ? `delete the data directory ${options.dataDirectory} (or point storage at a fresh location) and restart`
      : "delete this journal store's persisted data and restart";
    return new CrankError(
      "invalid_journal",
      `Stored journal data cannot be parsed under the current schema while ${operation} (${record}). ` +
        `Pre-cutover data is disposable: ${reset}. Parse failure: ${detail}`,
    );
  }

  function parseJournalCollections(
    entries: readonly Json[],
    journalHead: string,
  ): Array<[string, DurableSemanticRecord[]]> {
    const grouped = new Map<string, Json[]>();
    for (const entry of entries) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry["sessionId"] !== "string"
      ) {
        throw resetFailure(
          "replaying stored journal records",
          `journal entry after head ${journalHead}`,
          new Error("Stored authority journal entry is invalid"),
        );
      }
      const sessionId = entry["sessionId"];
      const sessionEntries = grouped.get(sessionId) ?? [];
      sessionEntries.push(entry);
      grouped.set(sessionId, sessionEntries);
    }
    return [...grouped.entries()].map(([sessionId, sessionEntries]) => {
      let parsed: DurableAuthoritySnapshot;
      try {
        parsed = parseDurableAuthoritySnapshot(
          JSON.stringify({ ...empty, records: [[sessionId, sessionEntries]] }),
        );
      } catch (error) {
        throw resetFailure(
          "replaying stored journal records",
          `session ${sessionId} (${sessionEntries.length} record(s) after head ${journalHead})`,
          error,
        );
      }
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
    let base: DurableAuthoritySnapshot;
    try {
      base = parseDurableAuthoritySnapshot(JSON.stringify({ ...payload.body, records: [] }));
    } catch (error) {
      throw resetFailure(
        "restoring the stored authority snapshot",
        `snapshot ${authorityControl.snapshot.id}`,
        error,
      );
    }
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
        records: parseJournalCollections(
          entries,
          authorityControl.journalHead?.segmentId ?? "none",
        ),
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

  function* mutateCommand<C extends AuthorityCommand>(command: C): Operation<CommandResult<C>> {
    let cancellationTargets: ReadonlyArray<{
      taskId: string;
      pullId: string;
      reason: string | undefined;
    }> = [];
    const committed = (yield* runExecutionCommitLoop(store, executionId, function* (current) {
      const loaded = yield* load(current);
      const history = loaded.snapshot.records.flatMap(([, records]) => records);
      const sessionId = commandSessionId(command, loaded.snapshot, options);
      const sessionRecords = history.filter((record) => record.sessionId === sessionId);
      const context: KernelContext = {
        nowMs: options.now?.() ?? Date.now(),
        journalIdentity: {
          id: options.journalId,
          incarnation: options.journalIncarnation ?? "1",
        },
        appendCursor: {
          sessionId,
          nextOffset: nextOffset(sessionRecords),
        },
        journalHeadDigest: canonicalSnapshot(sessionRecords).sha,
        keyring: options.keyring,
        schemas: options.schemaRegistry ?? createDurableSchemaRegistry(),
        ...(options.maxOutcomeBytes === undefined
          ? {}
          : { maxOutcomeBytes: options.maxOutcomeBytes }),
        ...(options.decisionDiagnostics === undefined
          ? {}
          : { decisionDiagnostics: options.decisionDiagnostics }),
        liveEffectTargets: liveEffectTargets(loaded.snapshot),
      };
      const loadedState = authorityStateFromSnapshot(loaded.snapshot);
      const transition = decideAuthorityTransition({
        state: loadedState,
        context,
        command,
      }) as KernelTransition<C>;
      cancellationTargets =
        command.type === "execution.request-cancellation"
          ? [
              ...(transition.state.sessions
                .get(command.request.sessionId)
                ?.execution.tasks.values() ?? []),
            ].flatMap((task) => {
              const lifecycle = task.lifecycle;
              return lifecycle.status === "active" &&
                lifecycle.cancellation.type === "settling_pull"
                ? [
                    {
                      taskId: task.taskId,
                      pullId: lifecycle.cancellation.pullId,
                      reason: lifecycle.cancellation.reason,
                    },
                  ]
                : [];
            })
          : [];
      const allRecords = [...history, ...transition.entries];
      const exported = snapshotFromAuthorityState(
        transition.state,
        groupJournalRecords(allRecords),
      );
      const compacted = compactAuthoritySnapshot(exported);
      if (
        transition.entries.length === 0 &&
        canonicalSnapshot(compacted).sha ===
          canonicalSnapshot(compactAuthoritySnapshot(loaded.snapshot)).sha
      ) {
        return { status: "return", result: transition.result };
      }
      const appended = [...transition.entries];
      const evicted = newlyEvictedRecords(loadedState, history, exported, compacted);
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
        result: transition.result,
      };
    })) as CommandResult<C>;
    if (command.type === "execution.request-cancellation") {
      for (const target of cancellationTargets) {
        if (hasLiveDurablePull(command.request.sessionId, target.taskId, target.pullId)) {
          signalLiveDurablePull(
            command.request.sessionId,
            target.taskId,
            target.pullId,
            target.reason,
          );
        }
      }
    }
    return committed;
  }

  function queryContext(sessionId = ""): KernelContext {
    return {
      nowMs: options.now?.() ?? Date.now(),
      journalIdentity: {
        id: options.journalId,
        incarnation: options.journalIncarnation ?? "1",
      },
      appendCursor: { sessionId, nextOffset: 0 },
      journalHeadDigest: "",
      keyring: options.keyring,
      schemas: options.schemaRegistry ?? createDurableSchemaRegistry(),
      ...(options.maxOutcomeBytes === undefined
        ? {}
        : { maxOutcomeBytes: options.maxOutcomeBytes }),
      ...(options.decisionDiagnostics === undefined
        ? {}
        : { decisionDiagnostics: options.decisionDiagnostics }),
    };
  }

  function* readQuery<Q extends AuthorityQuery>(query: Q): Operation<QueryResult<Q>> {
    const loaded = yield* load();
    return queryAuthorityState(
      authorityStateFromSnapshot(loaded.snapshot),
      queryContext(""),
      query,
    );
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

  const journal: AuthorityJournalContract = {
    *readSession(sessionId) {
      return yield* readJournalRecords(sessionId);
    },
    *readTree(sessionId, rootTaskId) {
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
  };
  const snapshot: AuthoritySnapshotContract = {
    *exportSnapshot() {
      const loaded = yield* load();
      return structuredClone(loaded.snapshot);
    },
  };
  const authorityDriver: JournalAuthorityContract = {
    *command<C extends AuthorityCommand>(command: C): Operation<CommandResult<C>> {
      return yield* mutateCommand(command);
    },
    *query<Q extends AuthorityQuery>(query: Q): Operation<QueryResult<Q>> {
      return yield* readQuery(query);
    },
  };

  return { authority: authorityDriver, journal, snapshot };
}

function liveEffectTargets(
  snapshot: DurableAuthoritySnapshot,
): readonly { taskId: string; pullId: string }[] {
  const state = authorityStateFromSnapshot(snapshot);
  const targets: { taskId: string; pullId: string }[] = [];
  for (const [sessionId, session] of state.sessions) {
    for (const task of session.execution.tasks.values()) {
      for (const action of task.actions) {
        if (
          action.kind === "pull" &&
          action.pull.resolution.status === "open" &&
          hasLiveDurablePull(sessionId, task.taskId, action.pull.pullId)
        ) {
          targets.push({ taskId: task.taskId, pullId: action.pull.pullId });
        }
      }
    }
  }
  return targets;
}

function nextOffset(records: readonly DurableSemanticRecord[]): number {
  let next = 0;
  for (const record of records) {
    const offset = Number(record.offset);
    if (Number.isSafeInteger(offset)) next = Math.max(next, offset + 1);
  }
  return next;
}

function groupJournalRecords(
  records: readonly DurableSemanticRecord[],
): Array<[string, readonly DurableSemanticRecord[]]> {
  const grouped = new Map<string, DurableSemanticRecord[]>();
  for (const record of records) {
    const values = grouped.get(record.sessionId) ?? [];
    values.push(record);
    grouped.set(record.sessionId, values);
  }
  return [...grouped.entries()];
}

function commandSessionId(
  command: AuthorityCommand,
  snapshot: DurableAuthoritySnapshot,
  options: StoredJournalAuthorityOptions,
): string {
  const structural = structuralCommandSessionId(command);
  if (structural !== undefined) return structural;
  if (command.type === "execution.resolve-pull") {
    try {
      return verifyResolutionCapability(
        command.request.capability,
        options.keyring,
        command.request.audience,
      ).sessionId;
    } catch {
      return "";
    }
  }
  if (
    command.type === "execution.accept-preparation" ||
    command.type === "execution.accept-assistant-partial"
  ) {
    for (const [sessionId, session] of authorityStateFromSnapshot(snapshot).sessions) {
      if (session.execution.tasks.has(command.request.taskId)) return sessionId;
    }
    return "";
  }
  return "";
}

/**
 * Records evicted by this commit that no earlier commit archived. The stored
 * topology names exactly the tasks retained by the previous commit, so any
 * history record outside it was archived by the commit that evicted it.
 * Archiving only this delta keeps the replay chain linear in unique events
 * instead of re-archiving the complete evicted history on every command.
 */
function newlyEvictedRecords(
  previousState: AuthorityState,
  history: readonly DurableSemanticRecord[],
  exported: DurableAuthoritySnapshot,
  compacted: DurableAuthoritySnapshot,
): DurableSemanticRecord[] {
  const retainedEventIds = new Set(
    compacted.records.flatMap(([, records]) => records.map((record) => record.eventId)),
  );
  const previouslyRetained = new Map(
    [...previousState.sessions].map(([sessionId, session]) => [
      sessionId,
      new Set(session.execution.tasks.keys()),
    ]),
  );
  const previouslyArchivedEventIds = new Set(
    history
      .filter((record) => !previouslyRetained.get(record.sessionId)?.has(record.payload.taskId))
      .map((record) => record.eventId),
  );
  return exported.records.flatMap(([, records]) =>
    records.filter(
      (record) =>
        !retainedEventIds.has(record.eventId) && !previouslyArchivedEventIds.has(record.eventId),
    ),
  );
}

/** Retains active trees or only the latest terminal tree for each session. */
function compactAuthoritySnapshot(snapshot: DurableAuthoritySnapshot): DurableAuthoritySnapshot {
  const state = authorityStateFromSnapshot(snapshot);
  const sessions = new Map();
  const retainedBySession = new Map<string, Set<string>>();
  for (const [sessionId, session] of state.sessions) {
    const tasks = [...session.execution.tasks.values()];
    const roots = tasks.filter((task) => task.origin.kind === "root");
    const active = roots.filter((task) => task.lifecycle.status === "active");
    const retained = new Set(
      (active.length > 0 ? active : roots.slice(-1)).map((task) => task.taskId),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (
          task.origin.kind === "child" &&
          retained.has(task.origin.invokedBy.taskId) &&
          !retained.has(task.taskId)
        ) {
          retained.add(task.taskId);
          changed = true;
        }
      }
    }
    retainedBySession.set(sessionId, retained);
    sessions.set(sessionId, {
      ...session,
      execution: {
        tasks: new Map([...session.execution.tasks].filter(([taskId]) => retained.has(taskId))),
      },
    });
  }
  return snapshotFromAuthorityState(
    { sessions, nextNonce: state.nextNonce },
    snapshot.records.map(([sessionId, records]) => [
      sessionId,
      records.filter((record) => retainedBySession.get(sessionId)?.has(record.payload.taskId)),
    ]),
  );
}
