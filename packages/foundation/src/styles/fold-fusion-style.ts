/**
 * Style experiment: applicative fold fusion for indexed derivations.
 *
 * The primitive graduated to `foundation/src/fold.ts`; this file keeps the
 * degenerate graph domain that justified it. Items form a graph by `parent`,
 * which may name an id that never arrives. Four independent indexes fuse into
 * one pass; partitioning edges into attached/pending needs the complete id
 * set, so it is post-processing rather than a second source traversal.
 */
export * from "../fold.ts";

import { combine, fold, type Fold } from "../fold.ts";

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
