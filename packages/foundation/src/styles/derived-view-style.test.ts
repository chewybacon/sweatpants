import { describe, expect, it } from "vitest";
import {
  createDerived,
  createGraphViewCache,
  createMaintained,
  deriveGraphView,
  foldDerived,
  foldMaintained,
  GraphConflictError,
  materializeDerived,
  materializeMaintained,
  replayDerived,
  replayMaintained,
  type GraphEvent,
} from "./derived-view-style.ts";

const text = (messageId: string, delta: string): GraphEvent => ({ type: "text", messageId, delta });
const tool = (callId: string, messageId: string, sequence: number): GraphEvent => ({
  type: "tool",
  callId,
  messageId,
  sequence,
});
const activity = (recordId: string, messageId: string, sequence: number): GraphEvent => ({
  type: "activity",
  recordId,
  messageId,
  sequence,
});
const placeMessage = (nodeId: string, messageId: string, sequence: number): GraphEvent => ({
  type: "place-message",
  nodeId,
  messageId,
  sequence,
});
const placeNode = (
  nodeId: string,
  parentNodeId: string,
  recordId: string,
  sequence: number,
): GraphEvent => ({ type: "place-node", nodeId, parentNodeId, recordId, sequence });

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

type Outcome = { readonly index: number; readonly error: unknown } | null;

function maintainedFailure(events: readonly GraphEvent[]): Outcome {
  let state = createMaintained();
  for (let index = 0; index < events.length; index += 1) {
    try {
      state = foldMaintained(state, events[index]!);
    } catch (error) {
      return { index, error };
    }
  }
  return null;
}

function derivedFailure(events: readonly GraphEvent[]): Outcome {
  let state = createDerived();
  for (let index = 0; index < events.length; index += 1) {
    try {
      state = foldDerived(state, events[index]!);
      deriveGraphView(state.nodes);
    } catch (error) {
      return { index, error };
    }
  }
  return null;
}

/** One message whose placement, content, and children can arrive in any order. */
const conversation: readonly GraphEvent[] = [
  text("m1", "hello"),
  tool("c1", "m1", 1),
  activity("r1", "m1", 2),
  placeMessage("placed:m1", "m1", 0),
];

const expectedTree = [
  {
    id: "message:m1",
    text: "hello",
    children: [
      { id: "tool:c1", children: [] },
      { id: "activity:r1", children: [] },
    ],
  },
];

describe("maintained indexes vs derived view", () => {
  it("both styles agree when placement precedes children", () => {
    const inOrder = [conversation[3]!, conversation[0]!, conversation[1]!, conversation[2]!];
    expect(materializeMaintained(replayMaintained(inOrder))).toEqual(expectedTree);
    expect(materializeDerived(replayDerived(inOrder))).toEqual(expectedTree);
  });

  it("maintained style survives late placement only through child-migration surgery", () => {
    // Synthetic tool child arrives before placement: migrateProvisionalMessage
    // must rewrite its parent pointer. The derived style has nothing to rewrite.
    const latePlacement = [
      text("m1", "hello"),
      tool("c1", "m1", 1),
      placeMessage("placed:m1", "m1", 0),
    ];
    const expected = [
      { id: "message:m1", text: "hello", children: [{ id: "tool:c1", children: [] }] },
    ];
    expect(materializeMaintained(replayMaintained(latePlacement))).toEqual(expected);
    expect(materializeDerived(replayDerived(latePlacement))).toEqual(expected);
  });

  it("maintained style rejects an authoritative child that precedes placement; derived converges", () => {
    // Production's "authoritative child cannot move with provisional message".
    const authoritativeFirst = [
      text("m1", "hello"),
      activity("r1", "m1", 2),
      placeMessage("placed:m1", "m1", 0),
    ];

    expect(() => replayMaintained(authoritativeFirst)).toThrow(GraphConflictError);
    expect(() => replayMaintained(authoritativeFirst)).toThrow(/cannot move with provisional/);

    expect(materializeDerived(replayDerived(authoritativeFirst))).toEqual([
      {
        id: "message:m1",
        text: "hello",
        children: [{ id: "activity:r1", children: [] }],
      },
    ]);
  });

  it("derived folds are order-independent; maintained folds fail exactly when an authoritative child precedes placement", () => {
    const all = permutations(conversation);
    expect(all).toHaveLength(24);

    for (const permutation of all) {
      expect(materializeDerived(replayDerived(permutation))).toEqual(expectedTree);
    }

    const activityBeforePlacement = (events: readonly GraphEvent[]): boolean =>
      events.findIndex((event) => event.type === "activity") <
      events.findIndex((event) => event.type === "place-message");

    const failing = all.filter(activityBeforePlacement);
    const passing = all.filter((events) => !activityBeforePlacement(events));
    expect(failing).toHaveLength(12);
    expect(passing).toHaveLength(12);

    for (const permutation of passing) {
      expect(materializeMaintained(replayMaintained(permutation))).toEqual(expectedTree);
    }
    for (const permutation of failing) {
      expect(() => replayMaintained(permutation)).toThrow(GraphConflictError);
    }
  });

  it("children attach transitively with no attachment logic in the fold", () => {
    const chain = [
      placeNode("node:grand", "node:child", "grand", 0),
      placeNode("node:child", "placed:m1", "child", 0),
      placeMessage("placed:m1", "m1", 0),
    ];
    const snapshots: (readonly unknown[])[] = [];
    let maintained = createMaintained();
    let derived = createDerived();
    for (const event of chain) {
      maintained = foldMaintained(maintained, event);
      derived = foldDerived(derived, event);
      // Orphan subtrees are simply unreachable until their ancestors arrive.
      expect(materializeDerived(derived)).toEqual(materializeMaintained(maintained));
      snapshots.push(materializeDerived(derived));
    }
    expect(snapshots[0]).toEqual([]);
    expect(snapshots[1]).toEqual([]);
    expect(snapshots[2]).toEqual([
      {
        id: "message:m1",
        text: "",
        children: [{ id: "activity:child", children: [{ id: "activity:grand", children: [] }] }],
      },
    ]);
  });

  it("keeps the derived fold state irreducible", () => {
    const state = replayDerived(conversation);
    expect(Object.keys(state)).toEqual(["nodes", "text"]);
  });

  it("conflicts surface on the same event in both styles", () => {
    const siblingConflict = [
      placeMessage("placed:m1", "m1", 0),
      tool("c1", "m1", 1),
      tool("c2", "m1", 1),
    ];
    const maintainedSibling = maintainedFailure(siblingConflict);
    const derivedSibling = derivedFailure(siblingConflict);
    expect(maintainedSibling?.index).toBe(2);
    expect(derivedSibling?.index).toBe(2);
    expect(maintainedSibling?.error).toBeInstanceOf(GraphConflictError);
    expect(derivedSibling?.error).toBeInstanceOf(GraphConflictError);

    const doublePlacement = [
      placeMessage("placed-a:m1", "m1", 0),
      placeMessage("placed-b:m1", "m1", 0),
    ];
    expect(maintainedFailure(doublePlacement)?.index).toBe(1);
    expect(derivedFailure(doublePlacement)?.index).toBe(1);
  });

  it("content deltas never recompute the derived view", () => {
    let derivations = 0;
    const cache = createGraphViewCache(() => {
      derivations += 1;
    });

    let state = createDerived();
    state = foldDerived(state, placeMessage("placed:m1", "m1", 0));
    cache.view(state.nodes);
    expect(derivations).toBe(1);

    for (let index = 0; index < 50; index += 1) {
      state = foldDerived(state, text("m1", `delta-${index} `));
      cache.view(state.nodes);
    }
    // 50 content folds copied `text` but reused `nodes`: zero re-derivations.
    expect(derivations).toBe(1);

    state = foldDerived(state, tool("c1", "m1", 1));
    cache.view(state.nodes);
    expect(derivations).toBe(2);
  });
});
