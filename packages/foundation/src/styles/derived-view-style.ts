/**
 * Style experiment: incrementally maintained indexes vs one derived view.
 *
 * Models the essence of the chat projection fold: a node graph where a message
 * may first exist as a fold-synthesized ("synthetic") record and later be
 * replaced by a producer-placed ("authoritative") record, while children
 * arrive in any order.
 *
 * Style M (maintained) mirrors production `chat-client-projection.ts`: edges
 * are keyed by physical node id and five indexes are updated by hand on every
 * mutation, so replacing a synthetic node requires child-migration surgery.
 *
 * Style D (derived) keys edges by stable logical identity. The fold state is
 * an irreducible fact store; every index is one O(n) derivation memoized on
 * the identity of the nodes map.
 *
 * Production mapping:
 *
 *   MaintainedState.messageNode          ChatProjectionState.messageNodeById
 *   MaintainedState.attached             ChatProjectionState.attachedChildren
 *   MaintainedState.pending              ChatProjectionState.pendingChildren
 *   migrateProvisionalMessage            replaceSyntheticMessageNode
 *   insertMaintained + attachPendingTo   addGraphNode + attachPending
 *   DerivedState.nodes                   the proposed irreducible fact store
 *   deriveGraphView                      the proposed derivation
 *   createGraphViewCache                 WeakMap memo keyed on nodes identity
 *
 * Deliberately not modeled: mutable-fact merge rules (preserveSettledToolResult,
 * cloneNodeWithMutable), the structured-output streaming cursor, and
 * messageOrder arrival semantics (the materializer here sorts roots by logical
 * identity to isolate structural convergence). No generators are involved:
 * this decomposition is data modeling, not composition.
 */

export class GraphConflictError extends Error {
  readonly code = "graph_conflict";

  constructor(message: string) {
    super(message);
    this.name = "GraphConflictError";
  }
}

export type GraphEvent =
  | { readonly type: "text"; readonly messageId: string; readonly delta: string }
  | {
      readonly type: "tool";
      readonly callId: string;
      readonly messageId: string;
      readonly sequence: number;
    }
  | {
      readonly type: "activity";
      readonly recordId: string;
      readonly messageId: string;
      readonly sequence: number;
    }
  | {
      readonly type: "place-message";
      readonly nodeId: string;
      readonly messageId: string;
      readonly sequence: number;
    }
  | {
      readonly type: "place-node";
      readonly nodeId: string;
      readonly parentNodeId: string;
      readonly recordId: string;
      readonly sequence: number;
    };

/** Physical-id-independent tree for comparing the two styles. */
export interface TreeNode {
  readonly id: string;
  readonly text?: string;
  readonly children: readonly TreeNode[];
}

type NodeKind = "message" | "tool" | "activity";

function addToList(
  map: ReadonlyMap<string, readonly string[]>,
  key: string,
  value: string,
): Map<string, readonly string[]> {
  const next = new Map(map);
  next.set(key, [...(next.get(key) ?? []), value]);
  return next;
}

// =============================================================================
// STYLE M: maintained indexes, physical edges (mirrors production)
// =============================================================================

interface MaintainedNode {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
  readonly kind: NodeKind;
  readonly ref: string;
  readonly synthetic: boolean;
}

export interface MaintainedState {
  readonly nodes: ReadonlyMap<string, MaintainedNode>;
  readonly messageNode: ReadonlyMap<string, string>;
  readonly attached: ReadonlyMap<string, readonly string[]>;
  readonly pending: ReadonlyMap<string, readonly string[]>;
  readonly text: ReadonlyMap<string, string>;
}

export function createMaintained(): MaintainedState {
  return {
    nodes: new Map(),
    messageNode: new Map(),
    attached: new Map(),
    pending: new Map(),
    text: new Map(),
  };
}

function assertSiblingSequence(
  state: MaintainedState,
  parentId: string,
  sequence: number,
  excluding?: string,
): void {
  for (const siblingId of state.attached.get(parentId) ?? []) {
    if (siblingId === excluding) continue;
    if (state.nodes.get(siblingId)!.sequence === sequence) {
      throw new GraphConflictError(`sibling sequence ${sequence} occupied under ${parentId}`);
    }
  }
}

/** Mirrors production addGraphNode + attachPending: every insert must keep five structures consistent. */
function insertMaintained(state: MaintainedState, node: MaintainedNode): MaintainedState {
  const existing = state.nodes.get(node.nodeId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(node)) {
      throw new GraphConflictError(`node ${node.nodeId} reused with conflicting facts`);
    }
    return state;
  }
  const nodes = new Map(state.nodes).set(node.nodeId, node);
  if (node.parentNodeId === null) {
    return attachPendingTo({ ...state, nodes }, node.nodeId);
  }
  if (!nodes.has(node.parentNodeId)) {
    return { ...state, nodes, pending: addToList(state.pending, node.parentNodeId, node.nodeId) };
  }
  assertSiblingSequence(state, node.parentNodeId, node.sequence);
  const attached = addToList(state.attached, node.parentNodeId, node.nodeId);
  return attachPendingTo({ ...state, nodes, attached }, node.nodeId);
}

function attachPendingTo(state: MaintainedState, parentId: string): MaintainedState {
  const waiting = state.pending.get(parentId) ?? [];
  if (waiting.length === 0) {
    return state;
  }
  const pending = new Map(state.pending);
  pending.delete(parentId);
  let next: MaintainedState = { ...state, pending };
  for (const childId of waiting) {
    const child = next.nodes.get(childId)!;
    assertSiblingSequence(next, parentId, child.sequence, childId);
    next = { ...next, attached: addToList(next.attached, parentId, childId) };
    next = attachPendingTo(next, childId);
  }
  return next;
}

function ensureMessageMaintained(state: MaintainedState, messageId: string): MaintainedState {
  if (state.messageNode.has(messageId)) {
    return state;
  }
  const nodeId = `message:${messageId}`;
  const next = insertMaintained(state, {
    nodeId,
    parentNodeId: null,
    sequence: 0,
    kind: "message",
    ref: messageId,
    synthetic: true,
  });
  return { ...next, messageNode: new Map(next.messageNode).set(messageId, nodeId) };
}

/**
 * Mirrors production replaceSyntheticMessageNode: five structures updated in
 * one motion, with a hand-written rule about which children may migrate.
 */
function migrateProvisionalMessage(
  state: MaintainedState,
  messageId: string,
  nodeId: string,
): MaintainedState {
  const oldNodeId = state.messageNode.get(messageId);
  const messageNode = new Map(state.messageNode).set(messageId, nodeId);
  if (!oldNodeId || oldNodeId === nodeId) {
    return { ...state, messageNode };
  }
  const oldNode = state.nodes.get(oldNodeId)!;
  if (!oldNode.synthetic) {
    throw new GraphConflictError(`message ${messageId} was placed twice`);
  }
  const children = state.attached.get(oldNodeId) ?? [];
  const nodes = new Map(state.nodes);
  nodes.delete(oldNodeId);
  for (const childId of children) {
    const child = nodes.get(childId)!;
    if (!child.synthetic) {
      throw new GraphConflictError(
        `authoritative child ${childId} cannot move with provisional message ${messageId}`,
      );
    }
    nodes.set(childId, { ...child, parentNodeId: nodeId });
  }
  const attached = new Map(state.attached);
  attached.delete(oldNodeId);
  if (children.length > 0) {
    attached.set(nodeId, [...children]);
  }
  const pending = new Map(state.pending);
  const waiting = pending.get(oldNodeId);
  pending.delete(oldNodeId);
  if (waiting && waiting.length > 0) {
    pending.set(nodeId, waiting);
  }
  return { ...state, nodes, attached, pending, messageNode };
}

export function foldMaintained(state: MaintainedState, event: GraphEvent): MaintainedState {
  switch (event.type) {
    case "text": {
      const next = ensureMessageMaintained(state, event.messageId);
      const text = new Map(next.text);
      text.set(event.messageId, (text.get(event.messageId) ?? "") + event.delta);
      return { ...next, text };
    }
    case "tool": {
      const next = ensureMessageMaintained(state, event.messageId);
      return insertMaintained(next, {
        nodeId: `tool:${event.callId}`,
        // Physical parent resolved at ingest time; migration must fix it later.
        parentNodeId: next.messageNode.get(event.messageId)!,
        sequence: event.sequence,
        kind: "tool",
        ref: event.callId,
        synthetic: true,
      });
    }
    case "activity": {
      const next = ensureMessageMaintained(state, event.messageId);
      return insertMaintained(next, {
        nodeId: `activity:${event.recordId}`,
        // Same physical resolution, but authoritative records may not migrate.
        parentNodeId: next.messageNode.get(event.messageId)!,
        sequence: event.sequence,
        kind: "activity",
        ref: event.recordId,
        synthetic: false,
      });
    }
    case "place-message": {
      const migrated = migrateProvisionalMessage(state, event.messageId, event.nodeId);
      return insertMaintained(migrated, {
        nodeId: event.nodeId,
        parentNodeId: null,
        sequence: event.sequence,
        kind: "message",
        ref: event.messageId,
        synthetic: false,
      });
    }
    case "place-node":
      return insertMaintained(state, {
        nodeId: event.nodeId,
        parentNodeId: event.parentNodeId,
        sequence: event.sequence,
        kind: "activity",
        ref: event.recordId,
        synthetic: false,
      });
  }
}

export function materializeMaintained(state: MaintainedState): readonly TreeNode[] {
  const build = (nodeId: string): TreeNode => {
    const node = state.nodes.get(nodeId)!;
    const children = [...(state.attached.get(nodeId) ?? [])]
      .map((id) => state.nodes.get(id)!)
      .sort((a, b) => a.sequence - b.sequence || a.nodeId.localeCompare(b.nodeId))
      .map((child) => build(child.nodeId));
    return {
      id: `${node.kind}:${node.ref}`,
      ...(node.kind === "message" ? { text: state.text.get(node.ref) ?? "" } : {}),
      children,
    };
  };
  return [...state.nodes.values()]
    .filter((node) => node.parentNodeId === null)
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((node) => build(node.nodeId));
}

// =============================================================================
// STYLE D: irreducible fact store, logical edges, one derived view
// =============================================================================

export type ParentRef =
  | { readonly kind: "root" }
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "message"; readonly messageId: string };

interface DerivedNode {
  readonly nodeId: string;
  readonly parent: ParentRef;
  readonly sequence: number;
  readonly kind: NodeKind;
  readonly ref: string;
  readonly synthetic: boolean;
}

export interface DerivedState {
  readonly nodes: ReadonlyMap<string, DerivedNode>;
  readonly text: ReadonlyMap<string, string>;
}

export function createDerived(): DerivedState {
  return { nodes: new Map(), text: new Map() };
}

/** The entire structural fold. */
function insertDerived(state: DerivedState, node: DerivedNode): DerivedState {
  const existing = state.nodes.get(node.nodeId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(node)) {
      throw new GraphConflictError(`node ${node.nodeId} reused with conflicting facts`);
    }
    return state;
  }
  return { ...state, nodes: new Map(state.nodes).set(node.nodeId, node) };
}

function ensureMessageDerived(state: DerivedState, messageId: string): DerivedState {
  for (const node of state.nodes.values()) {
    if (node.kind === "message" && node.ref === messageId) {
      return state;
    }
  }
  return insertDerived(state, {
    nodeId: `message:${messageId}`,
    parent: { kind: "root" },
    sequence: 0,
    kind: "message",
    ref: messageId,
    synthetic: true,
  });
}

export function foldDerived(state: DerivedState, event: GraphEvent): DerivedState {
  switch (event.type) {
    case "text": {
      const next = ensureMessageDerived(state, event.messageId);
      const text = new Map(next.text);
      text.set(event.messageId, (text.get(event.messageId) ?? "") + event.delta);
      // Content deltas copy `text` but reuse `nodes`, so the memoized view survives.
      return { ...next, text };
    }
    case "tool":
      return insertDerived(ensureMessageDerived(state, event.messageId), {
        nodeId: `tool:${event.callId}`,
        // Logical parent: resolves to whichever node represents the message.
        parent: { kind: "message", messageId: event.messageId },
        sequence: event.sequence,
        kind: "tool",
        ref: event.callId,
        synthetic: true,
      });
    case "activity":
      return insertDerived(ensureMessageDerived(state, event.messageId), {
        nodeId: `activity:${event.recordId}`,
        parent: { kind: "message", messageId: event.messageId },
        sequence: event.sequence,
        kind: "activity",
        ref: event.recordId,
        synthetic: false,
      });
    case "place-message":
      return insertDerived(state, {
        nodeId: event.nodeId,
        parent: { kind: "root" },
        sequence: event.sequence,
        kind: "message",
        ref: event.messageId,
        synthetic: false,
      });
    case "place-node":
      return insertDerived(state, {
        nodeId: event.nodeId,
        parent: { kind: "node", nodeId: event.parentNodeId },
        sequence: event.sequence,
        kind: "activity",
        ref: event.recordId,
        synthetic: false,
      });
  }
}

export interface DerivedGraphView {
  readonly messageNode: ReadonlyMap<string, string>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly pending: ReadonlyMap<string, readonly string[]>;
  readonly roots: readonly string[];
}

/** One O(n) pass replaces every maintained index, including conflict checks. */
export function deriveGraphView(nodes: ReadonlyMap<string, DerivedNode>): DerivedGraphView {
  const messageNode = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "message") continue;
    const currentId = messageNode.get(node.ref);
    if (currentId === undefined) {
      messageNode.set(node.ref, node.nodeId);
      continue;
    }
    const current = nodes.get(currentId)!;
    if (current.synthetic && !node.synthetic) {
      messageNode.set(node.ref, node.nodeId);
    } else if (!current.synthetic && !node.synthetic) {
      throw new GraphConflictError(`message ${node.ref} was placed twice`);
    }
  }

  const shadowed = new Set<string>();
  for (const node of nodes.values()) {
    if (node.kind === "message" && node.synthetic && messageNode.get(node.ref) !== node.nodeId) {
      shadowed.add(node.nodeId);
    }
  }

  const children = new Map<string, string[]>();
  const pending = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes.values()) {
    if (shadowed.has(node.nodeId)) continue;
    if (node.parent.kind === "root") {
      roots.push(node.nodeId);
      continue;
    }
    const parentId =
      node.parent.kind === "message" ? messageNode.get(node.parent.messageId) : node.parent.nodeId;
    if (parentId === undefined || !nodes.has(parentId) || shadowed.has(parentId)) {
      const key =
        node.parent.kind === "message"
          ? `message-ref:${node.parent.messageId}`
          : node.parent.nodeId;
      const list = pending.get(key) ?? [];
      list.push(node.nodeId);
      pending.set(key, list);
      continue;
    }
    const list = children.get(parentId) ?? [];
    list.push(node.nodeId);
    children.set(parentId, list);
  }

  for (const [parentId, list] of children) {
    list.sort((a, b) => nodes.get(a)!.sequence - nodes.get(b)!.sequence || a.localeCompare(b));
    for (let index = 1; index < list.length; index += 1) {
      if (nodes.get(list[index - 1]!)!.sequence === nodes.get(list[index]!)!.sequence) {
        throw new GraphConflictError(
          `sibling sequence ${nodes.get(list[index]!)!.sequence} occupied under ${parentId}`,
        );
      }
    }
  }
  roots.sort((a, b) => nodes.get(a)!.ref.localeCompare(nodes.get(b)!.ref));

  return { messageNode, children, pending, roots };
}

/**
 * Memoized on the identity of the nodes map: content-only folds reuse the map
 * and therefore reuse the view; structural folds replace it and re-derive.
 */
export function createGraphViewCache(onDerive?: () => void): {
  view(nodes: ReadonlyMap<string, DerivedNode>): DerivedGraphView;
} {
  const cache = new WeakMap<ReadonlyMap<string, DerivedNode>, DerivedGraphView>();
  return {
    view(nodes) {
      const hit = cache.get(nodes);
      if (hit) return hit;
      onDerive?.();
      const view = deriveGraphView(nodes);
      cache.set(nodes, view);
      return view;
    },
  };
}

export function materializeDerived(state: DerivedState): readonly TreeNode[] {
  const view = deriveGraphView(state.nodes);
  const build = (nodeId: string): TreeNode => {
    const node = state.nodes.get(nodeId)!;
    return {
      id: `${node.kind}:${node.ref}`,
      ...(node.kind === "message" ? { text: state.text.get(node.ref) ?? "" } : {}),
      children: (view.children.get(nodeId) ?? []).map(build),
    };
  };
  return view.roots.map(build);
}

// =============================================================================
// Replay helpers with production-equivalent conflict timing
// =============================================================================

export function replayMaintained(events: readonly GraphEvent[]): MaintainedState {
  let state = createMaintained();
  for (const event of events) {
    state = foldMaintained(state, event);
  }
  return state;
}

/** Derives eagerly after every fold so conflicts surface on the offending event. */
export function replayDerived(
  events: readonly GraphEvent[],
  cache = createGraphViewCache(),
): DerivedState {
  let state = createDerived();
  for (const event of events) {
    state = foldDerived(state, event);
    cache.view(state.nodes);
  }
  return state;
}
