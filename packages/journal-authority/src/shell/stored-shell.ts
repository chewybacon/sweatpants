import { assertJson, uuidv7, type Json } from "@sweatpants/foundation";
import { CrankError, type DurableReference } from "@sweatpants/durable-execution";
import { retainParsedValue } from "../state/accepted-values.ts";
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
  StoredExecutionObject,
} from "../store/store.ts";
import { runExecutionCommitLoop } from "../store/commit-loop.ts";
import { createTextExecutionObject, createPrivateSegment } from "../store/store-persistence.ts";
import {
  DEFAULT_PRIVATE_SEGMENT_TARGET,
  segmentPrivateEntries,
  type PrivateSegmentTarget,
} from "../store/segmentation.ts";
import {
  decodeDurableAuthoritySnapshot,
  DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES,
  parseDurableAuthoritySnapshot,
  validateJournalCollectionBounds,
} from "../store/snapshot-codec.ts";
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
import { authorityStateFromSnapshot, projectAuthoritySnapshot } from "../state/authority-state.ts";
import { decideAuthorityTransition } from "../decisions/decision-pipeline.ts";
import { queryAuthorityState } from "../decisions/authority-decisions.ts";
import { advanceJournalHeadIdentities } from "./journal-head-identity.ts";
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
    readonly state: AuthorityState;
    readonly body: string | null;
    readonly authorityControl: AuthorityControl | null;
  }

  // Scope-owned accepted state. Durable control is checked before every reuse.
  interface AcceptedView {
    readonly control: ExecutionControl;
    readonly authorityControl: AuthorityControl;
    readonly snapshot: DurableAuthoritySnapshot;
    readonly state: AuthorityState;
    readonly body: string;
  }
  let view: AcceptedView | undefined;

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
    source: "storage" | "mutation" = "storage",
  ): Array<[string, DurableSemanticRecord[]]> {
    function failure(record: string, cause: unknown): CrankError {
      return source === "storage"
        ? resetFailure("replaying stored journal records", record, cause)
        : new CrankError("invalid_journal", "Mutation would produce invalid journal records");
    }
    const grouped = new Map<string, Json[]>();
    for (const entry of entries) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry["sessionId"] !== "string"
      ) {
        throw failure(
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
        const candidate = { ...empty, records: [[sessionId, sessionEntries]] };
        if (
          new TextEncoder().encode(JSON.stringify(candidate)).byteLength >
          DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES
        ) {
          throw new CrankError("invalid_journal", "Journal collection exceeds snapshot byte limit");
        }
        parsed = decodeDurableAuthoritySnapshot(candidate);
      } catch (error) {
        throw failure(
          `session ${sessionId} (${sessionEntries.length} record(s) after head ${journalHead})`,
          error,
        );
      }
      const collection = parsed.records[0] ?? [sessionId, []];
      for (const record of collection[1]) retainParsedValue(record);
      return collection;
    });
  }

  function appendValidatedJournalCollections(
    previous: DurableAuthoritySnapshot["records"],
    entries: readonly Json[],
  ): Array<[string, DurableSemanticRecord[]]> {
    // Previous collections belong to the accepted view; only new records cross
    // the schema boundary. Aggregate limits still apply to the complete history.
    const additions = parseJournalCollections(entries, "new append", "mutation");
    const collections = new Map(previous.filter(([, records]) => records.length > 0));
    for (const [sessionId, records] of additions) {
      collections.set(sessionId, [...(collections.get(sessionId) ?? []), ...records]);
    }
    for (const [sessionId, records] of collections)
      validateJournalCollectionBounds(sessionId, records);
    return [...collections];
  }

  function* load(supplied?: ExecutionControl | null): Operation<LoadedAuthority> {
    const current = supplied === undefined ? yield* store.loadControl(executionId) : supplied;
    if (!current) {
      view = undefined;
      const snapshot = decodeDurableAuthoritySnapshot(options.initialSnapshot ?? empty);
      return {
        control: null,
        snapshot,
        state: authorityStateFromSnapshot(snapshot),
        body: null,
        authorityControl: null,
      };
    }
    // The durable revision/fence identifies the accepted mutation. Internal
    // state needs no content serialization or restoration while these match.
    if (
      view &&
      current.controlRevision === view.control.controlRevision &&
      current.ownerFence === view.control.ownerFence
    ) {
      return { ...view, control: current };
    }
    const authorityControl = parseAuthorityControl(current.control);

    const payload = yield* store.getObject({ objectId: authorityControl.snapshot.id });
    if (!payload || typeof payload.body !== "string") {
      throw new CrankError("invalid_journal", "Stored authority snapshot payload is unavailable");
    }
    if (payload.lifetimeScope === "execution" && payload.scopeOwnerId !== executionId) {
      throw new CrankError(
        "invalid_journal",
        "Stored authority snapshot is outside execution scope",
      );
    }
    // The mutable authority object stores topology and frontiers only. The
    // complete semantic record collection is reconstructed from immutable
    // journal segments before the authority is handed to the in-memory engine.
    let base: DurableAuthoritySnapshot;
    try {
      // getObject verified this byte count.
      // Enforce the same boundary limit without serializing that body again.
      if (payload.byteLength > DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES) {
        throw new CrankError("invalid_journal", "Authority snapshot exceeds its byte limit");
      }
      base = parseDurableAuthoritySnapshot(payload.body);
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
    const snapshot = {
      ...base,
      records: parseJournalCollections(entries, authorityControl.journalHead?.segmentId ?? "none"),
    };
    const state = authorityStateFromSnapshot(snapshot);
    view = { control: current, authorityControl, snapshot, state, body: payload.body };
    return { control: current, authorityControl, snapshot, state, body: payload.body };
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

  function* makeSegments(
    taskId: string,
    previous: PrivateSegmentPointer | null,
    entries: readonly Json[],
    createdAt: number,
  ): Operation<StoredPrivateSegment[]> {
    if (entries.length === 0) return [];
    const target = options.privateSegmentTarget ?? DEFAULT_PRIVATE_SEGMENT_TARGET;
    const segments: StoredPrivateSegment[] = [];
    let cursor = previous;
    for (const batch of segmentPrivateEntries(entries, target)) {
      const first = cursor === null ? 1n : BigInt(cursor.lastSequence) + 1n;
      const last = first + BigInt(batch.entries.length - 1);
      const previous = cursor;
      const segment = yield* call(() =>
        createPrivateSegment(
          {
            executionId,
            taskId,
            previous,
            firstSequence: first.toString(10),
            lastSequence: last.toString(10),
            createdAt,
          },
          batch.entries,
        ),
      );
      segments.push(segment);
      cursor = { segmentId: segment.segmentId, lastSequence: segment.lastSequence };
    }
    return segments;
  }

  function* mutateCommand<C extends AuthorityCommand>(command: C): Operation<CommandResult<C>> {
    // Retry identical staged payloads under the same identity. Different CAS
    // candidates are bounded by the commit loop, as with content-addressed staging.
    const stagedSnapshots = new Map<string, StoredExecutionObject>();
    let cancellationTargets: ReadonlyArray<{
      taskId: string;
      pullId: string;
      reason: string | undefined;
    }> = [];
    const proposedHeads = new Map<string, string>();
    let committedView: AcceptedView | undefined;
    const committed = (yield* runExecutionCommitLoop(
      store,
      executionId,
      function* (current) {
        // A retry may return without committing; never publish its predecessor.
        committedView = undefined;
        const loaded = yield* load(current);
        const loadedState = loaded.state;
        const history = loaded.snapshot.records.flatMap(([, records]) => records);
        const sessionId = commandSessionId(command, loadedState, options);
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
          journalHeadId:
            loaded.snapshot.sessions.find(([id]) => id === sessionId)?.[1].control.journalHeadId ??
            "",
          keyring: options.keyring,
          schemas: options.schemaRegistry ?? createDurableSchemaRegistry(),
          maxOutcomeBytes: options.maxOutcomeBytes,
          decisionDiagnostics: options.decisionDiagnostics,
          liveEffectTargets: liveEffectTargets(loadedState),
        };
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
        const exported = projectAuthoritySnapshot(
          advanceJournalHeadIdentities(transition.state, transition.entries, proposedHeads),
          groupJournalRecords(allRecords),
        );
        const compacted = compactAuthoritySnapshot(exported);
        const snapshot = decodeDurableAuthoritySnapshot({ ...compacted, records: [] });
        // Snapshot IDs are minted, and integrity covers these exact opaque bytes.
        // Schema admission owns validity; canonical key sorting serves no identity.
        const body = JSON.stringify(snapshot);
        if (
          transition.entries.length === 0 &&
          body ===
            (loaded.body ??
              JSON.stringify({ ...compactAuthoritySnapshot(loaded.snapshot), records: [] }))
        ) {
          return { status: "return", result: transition.result };
        }
        const appended = [...transition.entries];
        const evicted = newlyEvictedRecords(loadedState, history, exported, compacted);
        const journal = yield* makeSegments(
          "authority",
          loaded.authorityControl?.journalHead ?? null,
          appended as unknown as Json[],
          options.now?.() ?? Date.now(),
        );
        const replay = yield* makeSegments(
          "authority-archive",
          loaded.authorityControl?.replayHead ?? null,
          evicted as unknown as Json[],
          options.now?.() ?? Date.now(),
        );
        // Persist an encoded snapshot as one opaque value. Generic object storage
        // verifies its bytes, without repeatedly walking the authority's schema.
        let object = stagedSnapshots.get(body);
        if (!object) {
          object = yield* call(() =>
            createTextExecutionObject(
              {
                objectId: uuidv7(),
                lifetimeScope: "execution",
                scopeOwnerId: executionId,
                objectKind: "authority-snapshot",
                createdAt: options.now?.() ?? Date.now(),
              },
              body,
            ),
          );
          stagedSnapshots.set(body, object);
        }
        const { contentHash, byteLength } = object;
        // Validate the exact representation a cold reader will restore, before
        // staging any writes. A successful commit must always be recoverable.
        if (byteLength > DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES) {
          throw new CrankError("invalid_journal", "Mutation exceeds authority snapshot byte limit");
        }
        const acceptedSnapshot = {
          ...snapshot,
          records: appendValidatedJournalCollections(
            loaded.snapshot.records,
            journal.flatMap((segment) => segment.entries),
          ),
        };
        const acceptedState = authorityStateFromSnapshot(acceptedSnapshot);
        const currentSnapshot = loaded.authorityControl?.snapshot;
        const snapshotId =
          currentSnapshot?.integrity?.value === contentHash ? currentSnapshot.id : object.objectId;
        const objects = snapshotId === currentSnapshot?.id ? [] : [object];
        const next = control(
          {
            id: snapshotId,
            byteLength,
            version: "1",
            integrity: { algorithm: "sha256", value: contentHash },
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
        );
        const candidate = {
          authorityControl: parseAuthorityControl(next.control),
          snapshot: acceptedSnapshot,
          state: acceptedState,
          body,
        };
        return {
          status: "commit",
          next,
          ...(journal.length > 0 ? { journalSegments: journal } : {}),
          ...(replay.length > 0 ? { replaySegments: replay } : {}),
          objects,
          onCommitted(control: ExecutionControl) {
            committedView = { ...candidate, control };
          },
          result: transition.result,
        };
      },
      64,
      view?.control,
    )) as CommandResult<C>;
    // Publish only the winning, validated candidate. Losing drafts never replace
    // the accepted state, and a successful commit needs no restoration pass.
    // Every later operation still reads durable control before reusing the view.
    if (committedView) {
      view = committedView;
    }
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
      journalHeadId: "",
      keyring: options.keyring,
      schemas: options.schemaRegistry ?? createDurableSchemaRegistry(),
      maxOutcomeBytes: options.maxOutcomeBytes,
      decisionDiagnostics: options.decisionDiagnostics,
    };
  }

  function* readQuery<Q extends AuthorityQuery>(query: Q): Operation<QueryResult<Q>> {
    const loaded = yield* load();
    return queryAuthorityState(loaded.state, queryContext(""), query);
  }

  function* readJournalRecords(sessionId: string): Operation<DurableSemanticRecord[]> {
    // load() already reconstructs and validates the complete immutable journal.
    const loaded = yield* load();
    return structuredClone(
      loaded.snapshot.records.find(([storedSessionId]) => storedSessionId === sessionId)?.[1] ?? [],
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

function liveEffectTargets(state: AuthorityState): readonly { taskId: string; pullId: string }[] {
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
  state: AuthorityState,
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
    for (const [sessionId, session] of state.sessions) {
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
  const retainedBySession = new Map<string, Set<string>>();
  for (const [sessionId, session] of snapshot.sessions) {
    const tasks = session.execution.tasks;
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
  }
  // This only selects topology. Admission validates the candidate before writes;
  // the already accepted input needs no restoration pass to select its roots.
  return {
    version: 1,
    sessions: snapshot.sessions.map(([sessionId, session]) => [
      sessionId,
      {
        control: session.control,
        execution: {
          tasks: session.execution.tasks.filter((task) =>
            retainedBySession.get(sessionId)?.has(task.taskId),
          ),
        },
      },
    ]),
    nextNonce: snapshot.nextNonce,
    records: snapshot.records.map(([sessionId, records]) => [
      sessionId,
      records.filter((record) => retainedBySession.get(sessionId)?.has(record.payload.taskId)),
    ]),
  };
}
