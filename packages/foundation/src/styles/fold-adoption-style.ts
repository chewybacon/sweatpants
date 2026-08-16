/**
 * Style experiment: what full `Fold` adoption looks like on a real derivation.
 *
 * Models `indexRecordProjection` (durable-chat-runtime) — the worst production
 * case, currently five separate loops over the same records. Adds the two
 * combinators adoption would require beyond `combine`:
 *
 *   mapFold    functor  — post-process completed accumulators
 *   prefilter  narrows which items a fold does work for
 *
 * The claim under test is one I asserted in the previous experiment and did
 * not verify: that a phase depending on another phase's output "forces a
 * second traversal". That is false whenever the dependency is on data from the
 * *same* traversal. Resolving model message identities needs the completed
 * `prepared` map, yet stays in one pass because `done()` sees every
 * accumulator. It is `map` over a combined fold, not a second phase.
 *
 * A genuine second traversal is required only when a phase must re-read the
 * source with knowledge derived from it. None of our three derivations do.
 *
 * Cost, stated honestly: resolving in `done()` buffers intermediate data
 * instead of re-reading. Bounded here by the window, but it is memory traded
 * for passes, not a free win.
 */
import { combine, fold, runFold, type Fold } from "./fold-fusion-style.ts";

/** Functor: post-process a fold's result once the accumulator is complete. */
export function mapFold<In, A, B>(source: Fold<In, A>, project: (value: A) => B): Fold<In, B> {
  return fold(() => {
    const stepper = source.start();
    return {
      step: (item) => stepper.step(item),
      done: () => project(stepper.done()),
    };
  });
}

/** Do work only for items the predicate admits; the traversal is still shared. */
export function prefilter<In, Narrowed extends In, Out>(
  admits: (item: In) => item is Narrowed,
  source: Fold<Narrowed, Out>,
): Fold<In, Out> {
  return fold(() => {
    const stepper = source.start();
    return {
      step(item) {
        if (admits(item)) stepper.step(item);
      },
      done: () => stepper.done(),
    };
  });
}

// =============================================================================
// Degenerate model of durable semantic records
// =============================================================================

export type DurableRecord =
  | {
      readonly kind: "pull";
      readonly taskId: string;
      readonly pullId: string;
      readonly model: boolean;
    }
  | {
      readonly kind: "prepared";
      readonly taskId: string;
      readonly pullId: string;
      readonly messageId: string;
    }
  | {
      readonly kind: "emission";
      readonly taskId: string;
      readonly event: "text" | "started" | "completed";
      readonly callId: string | null;
    }
  | { readonly kind: "closed"; readonly taskId: string; readonly status: "ok" | "error" };

type PullRecord = Extract<DurableRecord, { kind: "pull" }>;
type PreparedRecord = Extract<DurableRecord, { kind: "prepared" }>;
type EmissionRecord = Extract<DurableRecord, { kind: "emission" }>;
type ClosedRecord = Extract<DurableRecord, { kind: "closed" }>;

const isPull = (record: DurableRecord): record is PullRecord => record.kind === "pull";
const isPrepared = (record: DurableRecord): record is PreparedRecord => record.kind === "prepared";
const isEmission = (record: DurableRecord): record is EmissionRecord => record.kind === "emission";
const isClosed = (record: DurableRecord): record is ClosedRecord => record.kind === "closed";

export function pullKey(taskId: string, pullId: string): string {
  return `${taskId.length}:${taskId}:${pullId}`;
}

export interface RecordIndex {
  readonly pulls: ReadonlyMap<string, PullRecord>;
  readonly unfinished: readonly string[];
  readonly terminal: ClosedRecord["status"] | null;
  /** Emission ordinal → public message identity. */
  readonly messageIds: ReadonlyMap<number, string | null>;
}

const pullsFold = prefilter(
  isPull,
  fold<PullRecord, ReadonlyMap<string, PullRecord>>(() => {
    const pulls = new Map<string, PullRecord>();
    return {
      step(record) {
        const key = pullKey(record.taskId, record.pullId);
        if (!pulls.has(key)) pulls.set(key, record);
      },
      done: () => pulls,
    };
  }),
);

/** Started/completed pairing resolves in `done()`, not in a second pass. */
const unfinishedFold = prefilter(
  isEmission,
  fold<EmissionRecord, readonly string[]>(() => {
    const started: string[] = [];
    const completed = new Set<string>();
    return {
      step(record) {
        if (record.callId === null) return;
        if (record.event === "started") started.push(record.callId);
        if (record.event === "completed") completed.add(record.callId);
      },
      done: () => started.filter((callId) => !completed.has(callId)),
    };
  }),
);

const terminalFold = prefilter(
  isClosed,
  fold<ClosedRecord, ClosedRecord["status"] | null>(() => {
    let status: ClosedRecord["status"] | null = null;
    return {
      step: (record) => void (status = record.status),
      done: () => status,
    };
  }),
);

const preparedFold = prefilter(
  isPrepared,
  fold<PreparedRecord, ReadonlyMap<string, string>>(() => {
    const prepared = new Map<string, string>();
    return {
      step: (record) => void prepared.set(pullKey(record.taskId, record.pullId), record.messageId),
      done: () => prepared,
    };
  }),
);

/**
 * Links each emission to the most recent preceding model pull for its task.
 * Observes both kinds, so it cannot prefilter — the ordering is the point.
 */
const emissionLinksFold: Fold<DurableRecord, ReadonlyMap<number, string | null>> = fold(() => {
  const lastModelPull = new Map<string, string>();
  const links = new Map<number, string | null>();
  let ordinal = 0;
  return {
    step(record) {
      if (record.kind === "pull" && record.model) {
        lastModelPull.set(record.taskId, pullKey(record.taskId, record.pullId));
        return;
      }
      if (record.kind !== "emission") return;
      links.set(ordinal, lastModelPull.get(record.taskId) ?? null);
      ordinal += 1;
    },
    done: () => links,
  };
});

/**
 * The whole index in ONE traversal. `messageIds` depends on `prepared`, which
 * is a different fold's output — resolved by `map` over the combined result
 * rather than by a second pass.
 */
export const recordIndexFold: Fold<DurableRecord, RecordIndex> = mapFold(
  combine({
    pulls: pullsFold,
    unfinished: unfinishedFold,
    terminal: terminalFold,
    prepared: preparedFold,
    links: emissionLinksFold,
  }),
  ({ pulls, unfinished, terminal, prepared, links }) => ({
    pulls,
    unfinished,
    terminal,
    messageIds: new Map(
      [...links].map(([ordinal, key]) => [
        ordinal,
        key === null ? null : (prepared.get(key) ?? null),
      ]),
    ),
  }),
);

export function indexRecords(records: Iterable<DurableRecord>): RecordIndex {
  return runFold(recordIndexFold, records);
}

/** The shape production is written in today: one loop per index. */
export function indexRecordsByHand(records: readonly DurableRecord[]): RecordIndex {
  const pulls = new Map<string, PullRecord>();
  for (const record of records) {
    if (record.kind !== "pull") continue;
    const key = pullKey(record.taskId, record.pullId);
    if (!pulls.has(key)) pulls.set(key, record);
  }

  const started: string[] = [];
  const completed = new Set<string>();
  for (const record of records) {
    if (record.kind !== "emission" || record.callId === null) continue;
    if (record.event === "started") started.push(record.callId);
    if (record.event === "completed") completed.add(record.callId);
  }

  let terminal: ClosedRecord["status"] | null = null;
  for (const record of records) {
    if (record.kind === "closed") terminal = record.status;
  }

  const prepared = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "prepared") continue;
    prepared.set(pullKey(record.taskId, record.pullId), record.messageId);
  }

  const lastModelPull = new Map<string, string>();
  const messageIds = new Map<number, string | null>();
  let ordinal = 0;
  for (const record of records) {
    if (record.kind === "pull" && record.model) {
      lastModelPull.set(record.taskId, pullKey(record.taskId, record.pullId));
      continue;
    }
    if (record.kind !== "emission") continue;
    const key = lastModelPull.get(record.taskId);
    messageIds.set(ordinal, key === undefined ? null : (prepared.get(key) ?? null));
    ordinal += 1;
  }

  return {
    pulls,
    unfinished: started.filter((callId) => !completed.has(callId)),
    terminal,
    messageIds,
  };
}
