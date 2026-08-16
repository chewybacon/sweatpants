/**
 * Style experiment: applicative fold fusion for indexed derivations.
 *
 * The projection programs compose *dependent* phases: `yield*` is a data
 * dependency, so each stage owns a traversal. That is the wrong primitive for
 * the inside of a derivation, where several indexes are computed from the same
 * items and do not feed each other. Splitting those into stages would trade
 * one traversal for N.
 *
 * Independent-and-combinable is applicative, not monadic. A `Fold` owns its
 * accumulator in a closure, so folds can be combined into a single fold that
 * produces every result in one pass — the same reason a database computes four
 * aggregates in one table scan.
 *
 * Degenerate model of the real derivations: items form a graph by `parent`,
 * which may reference an id that never arrives. Four independent indexes are
 * collected in one pass; partitioning edges into attached/pending genuinely
 * depends on the complete id set, so it is a second pass. That mixture —
 * a short sequential spine of fused stages — is the shape of
 * `refreshDerivedState`, `indexRecordProjection`, and `indexedTaskRecords`.
 */

export interface FoldStep<In, Out> {
  step(item: In): void;
  done(): Out;
}

/**
 * A fold whose accumulator is hidden in a closure. No existential type
 * parameter is needed, so folds of different accumulator types combine without
 * any cast at the call site.
 */
export interface Fold<In, Out> {
  start(): FoldStep<In, Out>;
}

export function fold<In, Out>(start: () => FoldStep<In, Out>): Fold<In, Out> {
  return { start };
}

export class FoldError extends Error {
  constructor(
    readonly foldKey: string,
    readonly reason: unknown,
  ) {
    super(`fold "${foldKey}" failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "FoldError";
  }
}

type OutputOf<In, F extends Fold<In, unknown>> = F extends Fold<In, infer Out> ? Out : never;

/**
 * Combine named folds into one fold. The result runs every member against each
 * item exactly once, so N indexes cost one traversal instead of N.
 */
export function combine<In, S extends Record<string, Fold<In, unknown>>>(
  folds: S,
): Fold<In, { readonly [K in keyof S]: OutputOf<In, S[K]> }> {
  return fold(() => {
    const members = Object.entries(folds).map(([key, member]) => [key, member.start()] as const);
    return {
      step(item) {
        for (const [key, member] of members) {
          try {
            member.step(item);
          } catch (error) {
            throw new FoldError(key, error);
          }
        }
      },
      done() {
        const output: Record<string, unknown> = {};
        for (const [key, member] of members) {
          output[key] = member.done();
        }
        return output as { readonly [K in keyof S]: OutputOf<In, S[K]> };
      },
    };
  });
}

export function runFold<In, Out>(target: Fold<In, Out>, items: Iterable<In>): Out {
  const stepper = target.start();
  for (const item of items) {
    stepper.step(item);
  }
  return stepper.done();
}

// =============================================================================
// Degenerate graph domain
// =============================================================================

export interface Item {
  readonly id: string;
  /** May name an id that never arrives. */
  readonly parent: string | null;
  /** Sibling ordering; duplicates under one parent are a conflict. */
  readonly slot: number;
  readonly tag: "alpha" | "beta";
}

export interface Edge {
  readonly child: string;
  readonly parent: string;
}

export const idsFold: Fold<Item, ReadonlySet<string>> = fold(() => {
  const ids = new Set<string>();
  return {
    step(item) {
      if (ids.has(item.id)) {
        throw new Error(`duplicate id ${item.id}`);
      }
      ids.add(item.id);
    },
    done: () => ids,
  };
});

export const byTagFold: Fold<Item, ReadonlyMap<Item["tag"], readonly string[]>> = fold(() => {
  const byTag = new Map<Item["tag"], string[]>();
  return {
    step(item) {
      const bucket = byTag.get(item.tag);
      if (bucket) bucket.push(item.id);
      else byTag.set(item.tag, [item.id]);
    },
    done: () => byTag,
  };
});

export const slotsFold: Fold<Item, ReadonlyMap<string, number>> = fold(() => {
  const slots = new Map<string, number>();
  return {
    step: (item) => void slots.set(item.id, item.slot),
    done: () => slots,
  };
});

export const edgesFold: Fold<Item, readonly Edge[]> = fold(() => {
  const edges: Edge[] = [];
  return {
    step(item) {
      if (item.parent !== null) edges.push({ child: item.id, parent: item.parent });
    },
    done: () => edges,
  };
});

/** Every index that needs no other index. One traversal. */
export const baseIndexes = combine({
  ids: idsFold,
  byTag: byTagFold,
  slots: slotsFold,
  edges: edgesFold,
});

export type BaseIndexes = ReturnType<ReturnType<typeof baseIndexes.start>["done"]>;

export interface ResolvedGraph {
  readonly attached: ReadonlyMap<string, readonly string[]>;
  readonly pending: ReadonlyMap<string, readonly string[]>;
}

/**
 * The dependent phase: an edge cannot be classified until the complete id set
 * is known, so this is genuinely a second traversal — over edges, not items.
 */
export function resolveGraph(base: BaseIndexes): ResolvedGraph {
  const attached = new Map<string, string[]>();
  const pending = new Map<string, string[]>();
  for (const edge of base.edges) {
    const bucket = base.ids.has(edge.parent) ? attached : pending;
    const list = bucket.get(edge.parent);
    if (list) list.push(edge.child);
    else bucket.set(edge.parent, [edge.child]);
  }
  for (const [parent, children] of attached) {
    const occupied = new Set<number>();
    for (const child of children) {
      const slot = base.slots.get(child)!;
      if (occupied.has(slot)) {
        throw new Error(`slot ${slot} is already occupied under ${parent}`);
      }
      occupied.add(slot);
    }
  }
  return { attached, pending };
}

/** The hand-fused baseline the composed version must match. */
export function deriveByHand(items: Iterable<Item>): {
  readonly base: BaseIndexes;
  readonly resolved: ResolvedGraph;
} {
  const ids = new Set<string>();
  const byTag = new Map<Item["tag"], string[]>();
  const slots = new Map<string, number>();
  const edges: Edge[] = [];
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`duplicate id ${item.id}`);
    }
    ids.add(item.id);
    const bucket = byTag.get(item.tag);
    if (bucket) bucket.push(item.id);
    else byTag.set(item.tag, [item.id]);
    slots.set(item.id, item.slot);
    if (item.parent !== null) edges.push({ child: item.id, parent: item.parent });
  }
  const base: BaseIndexes = { ids, byTag, slots, edges };
  return { base, resolved: resolveGraph(base) };
}
