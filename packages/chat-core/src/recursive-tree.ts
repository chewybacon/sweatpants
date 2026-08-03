import { canonicalJson, type Json } from "@sweatpants/foundation";

export interface TreePlacement {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
}

export type RecursiveMessageRole = "user" | "assistant" | "system";

export interface RecursiveTextPart {
  readonly type: "text";
  readonly id: string;
  readonly content: string;
  readonly rendered?: string;
}

export interface RecursiveReasoningPart {
  readonly type: "reasoning";
  readonly id: string;
  readonly content: string;
  readonly rendered?: string;
}

export interface RecursiveToolCallPart<TLocalRender = never> {
  readonly type: "tool-call";
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: Json;
  readonly state: "pending" | "running" | "complete" | "error";
  readonly execution: RecursiveExecutionNode<TLocalRender>;
  readonly result?: Json;
  readonly error?: string;
}

export type RecursiveMessagePart<TLocalRender = never> =
  | RecursiveTextPart
  | RecursiveReasoningPart
  | RecursiveToolCallPart<TLocalRender>;

export interface RecursiveChatMessage<TLocalRender = never> {
  readonly type: "message";
  readonly id: string;
  readonly placement: TreePlacement;
  readonly role: RecursiveMessageRole;
  readonly parts: readonly RecursiveMessagePart<TLocalRender>[];
}

export type RecursiveExecutionChild<TLocalRender = never> =
  | RecursiveChatMessage<TLocalRender>
  | RecursiveElicitNode<TLocalRender>
  | RecursiveExecutionNode<TLocalRender>;

export interface RecursiveExecutionNode<TLocalRender = never> {
  readonly type: "execution";
  readonly placement: TreePlacement;
  readonly executionId: string;
  readonly presentation: "public" | "opaque";
  readonly status: "running" | "complete" | "error" | "cancelled";
  readonly children: readonly RecursiveExecutionChild<TLocalRender>[];
}

export interface RecursiveElicitNode<TLocalRender = never> {
  readonly type: "elicit";
  readonly placement: TreePlacement;
  readonly elicitId: string;
  readonly bindingId: string;
  readonly key: string;
  readonly message: string;
  readonly context?: Json;
  readonly status: "pending" | "responded" | "cancelled";
  readonly renders: readonly TLocalRender[];
}

export type HostTreeNode =
  | RecursiveChatMessage<never>
  | RecursiveExecutionNode<never>
  | RecursiveElicitNode<never>;

export interface HostChatTreeSnapshot {
  readonly messages: readonly RecursiveChatMessage<never>[];
}

export type HostTreeDelta =
  | { readonly type: "tree_node_upsert"; readonly node: HostTreeNode }
  | {
      readonly type: "tree_node_settled";
      readonly nodeId: string;
      readonly status: "complete" | "error" | "cancelled" | "responded";
    };

export type TreeProjectionErrorCode = "client_tree_node_conflict" | "client_tree_parent_missing";

export class TreeProjectionError extends Error {
  constructor(
    readonly code: TreeProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TreeProjectionError";
  }
}

interface FlatNode {
  readonly node: HostTreeNode;
  readonly parentNodeId: string | null;
}

export interface HostTreeFoldState {
  readonly nodes: ReadonlyMap<string, FlatNode>;
  readonly pending: ReadonlyMap<string, readonly HostTreeNode[]>;
}

export function createHostTreeFoldState(snapshot?: HostChatTreeSnapshot): HostTreeFoldState {
  const nodes = new Map<string, FlatNode>();
  for (const message of snapshot?.messages ?? []) {
    addSnapshotNode(nodes, message);
  }
  return { nodes, pending: new Map() };
}

function addSnapshotNode(nodes: Map<string, FlatNode>, node: HostTreeNode): void {
  nodes.set(node.placement.nodeId, { node, parentNodeId: node.placement.parentNodeId });
  if (node.type === "message") {
    for (const part of node.parts) {
      if (part.type === "tool-call") {
        addSnapshotNode(nodes, part.execution);
      }
    }
  }
  if (node.type === "execution") {
    for (const child of node.children) {
      addSnapshotNode(nodes, child);
    }
  }
}

function immutableNodeContent(node: HostTreeNode): string {
  if (node.type === "message") {
    return canonicalJson({
      type: node.type,
      id: node.id,
      placement: node.placement,
      role: node.role,
      parts: node.parts.map((part) =>
        part.type === "tool-call"
          ? {
              type: part.type,
              id: part.id,
              callId: part.callId,
              name: part.name,
              arguments: part.arguments,
              execution: immutableNodeValue(part.execution),
            }
          : part,
      ),
    });
  }
  return canonicalJson(immutableNodeValue(node));
}

function immutableNodeValue(node: HostTreeNode): unknown {
  if (node.type === "execution") {
    return {
      type: node.type,
      placement: node.placement,
      executionId: node.executionId,
      presentation: node.presentation,
    };
  }
  if (node.type === "elicit") {
    return {
      type: node.type,
      placement: node.placement,
      elicitId: node.elicitId,
      bindingId: node.bindingId,
      key: node.key,
      message: node.message,
      ...(node.context !== undefined ? { context: node.context } : {}),
    };
  }
  return {
    type: node.type,
    id: node.id,
    placement: node.placement,
    role: node.role,
    parts: node.parts,
  };
}

function attachableParent(state: HostTreeFoldState, node: HostTreeNode): boolean {
  return node.placement.parentNodeId === null || state.nodes.has(node.placement.parentNodeId);
}

function embeddedNodes(node: HostTreeNode): readonly HostTreeNode[] {
  if (node.type === "message") {
    return node.parts.flatMap((part) => (part.type === "tool-call" ? [part.execution] : []));
  }
  return node.type === "execution" ? node.children : [];
}

function addNode(state: HostTreeFoldState, node: HostTreeNode): HostTreeFoldState {
  const nodeId = node.placement.nodeId;
  const previous = state.nodes.get(nodeId);
  if (previous) {
    if (immutableNodeContent(previous.node) !== immutableNodeContent(node)) {
      throw new TreeProjectionError(
        "client_tree_node_conflict",
        `[client_tree_node_conflict] Tree node "${nodeId}" was delivered with conflicting immutable content`,
      );
    }
    return state;
  }
  if (!attachableParent(state, node)) {
    const pending = new Map(state.pending);
    const parent = node.placement.parentNodeId!;
    pending.set(parent, [...(pending.get(parent) ?? []), node]);
    return { ...state, pending };
  }
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, { node, parentNodeId: node.placement.parentNodeId });
  let next: HostTreeFoldState = { ...state, nodes };

  // A message upsert carries its stable execution anchor, and an execution
  // upsert may carry already-known children. Register those structural facts
  // immediately; otherwise a later child delta would be buffered forever even
  // though its parent was present inside the upsert payload.
  for (const child of embeddedNodes(node)) {
    next = addNode(next, child);
  }

  const waiting = next.pending.get(nodeId) ?? [];
  if (waiting.length > 0) {
    const pending = new Map(next.pending);
    pending.delete(nodeId);
    next = { ...next, pending };
    for (const child of waiting) {
      next = addNode(next, child);
    }
  }
  return next;
}

type SettledTreeStatus = Extract<HostTreeDelta, { type: "tree_node_settled" }>["status"];

function settledNode(node: HostTreeNode, status: SettledTreeStatus): HostTreeNode {
  if (node.type === "elicit") {
    return {
      ...node,
      status:
        status === "responded" ? "responded" : status === "cancelled" ? "cancelled" : node.status,
    };
  }
  if (node.type === "execution") {
    return {
      ...node,
      status: status === "cancelled" ? "cancelled" : status === "error" ? "error" : "complete",
    };
  }
  return node;
}

export function foldHostTreeDelta(
  state: HostTreeFoldState,
  delta: HostTreeDelta,
): HostTreeFoldState {
  if (delta.type === "tree_node_upsert") {
    return addNode(state, delta.node);
  }
  const current = state.nodes.get(delta.nodeId);
  if (!current) {
    return state;
  }
  const nodes = new Map(state.nodes);
  nodes.set(delta.nodeId, {
    ...current,
    node: settledNode(current.node, delta.status),
  });
  return { ...state, nodes };
}

function childNodes(state: HostTreeFoldState, parentNodeId: string): HostTreeNode[] {
  return [...state.nodes.values()]
    .filter((entry) => entry.parentNodeId === parentNodeId)
    .sort((left, right) => left.node.placement.sequence - right.node.placement.sequence)
    .map((entry) => entry.node);
}

function materializeNode(state: HostTreeFoldState, node: HostTreeNode): HostTreeNode {
  // Settlements update the flat node map. Prefer that authoritative entry over
  // the embedded copy carried by the original parent upsert so execution and
  // elicitation status changes are visible in the materialized tree.
  const current = state.nodes.get(node.placement.nodeId)?.node ?? node;
  node = current;
  if (node.type === "message") {
    return {
      ...node,
      parts: node.parts.map((part) =>
        part.type === "tool-call"
          ? {
              ...part,
              execution: materializeNode(state, part.execution) as RecursiveExecutionNode<never>,
            }
          : part,
      ),
    };
  }
  if (node.type === "execution") {
    return {
      ...node,
      children: childNodes(state, node.placement.nodeId).map((child) =>
        materializeNode(state, child),
      ),
    };
  }
  return { ...node, renders: [] };
}

/** Materialize one immutable complete host tree from the flat fold. */
export function materializeHostTree(state: HostTreeFoldState): HostChatTreeSnapshot {
  if (state.pending.size > 0) {
    const parents = [...state.pending.keys()].join(", ");
    throw new TreeProjectionError(
      "client_tree_parent_missing",
      `[client_tree_parent_missing] Tree parents remain unresolved at settlement: ${parents}`,
    );
  }
  const roots = [...state.nodes.values()]
    .filter((entry) => entry.parentNodeId === null)
    .sort((left, right) => left.node.placement.sequence - right.node.placement.sequence);
  if (roots.some((entry) => entry.node.type !== "message")) {
    throw new TreeProjectionError(
      "client_tree_parent_missing",
      "Only message nodes may be roots of the public host tree",
    );
  }
  return Object.freeze({
    messages: Object.freeze(
      roots.map((entry) => materializeNode(state, entry.node) as RecursiveChatMessage<never>),
    ),
  });
}

export function foldHostTreeDeltas(
  deltas: readonly HostTreeDelta[],
  initial?: HostChatTreeSnapshot,
): HostChatTreeSnapshot {
  let state = createHostTreeFoldState(initial);
  for (const delta of deltas) {
    state = foldHostTreeDelta(state, delta);
  }
  return materializeHostTree(state);
}

export function applyHostToolResult(
  snapshot: HostChatTreeSnapshot,
  input: { readonly callId: string; readonly content: Json; readonly isError: boolean },
): HostChatTreeSnapshot {
  const updateNode = (node: HostTreeNode): HostTreeNode => {
    if (node.type === "message") {
      return {
        ...node,
        parts: node.parts.map((part) => {
          if (part.type !== "tool-call") {
            return part;
          }
          const execution = updateNode(part.execution) as RecursiveExecutionNode<never>;
          if (part.callId !== input.callId) {
            return { ...part, execution };
          }
          return {
            ...part,
            state: input.isError ? "error" : "complete",
            execution,
            ...(input.isError ? { error: String(input.content) } : { result: input.content }),
          };
        }),
      };
    }
    if (node.type === "execution") {
      return { ...node, children: node.children.map(updateNode) };
    }
    return node;
  };
  const messages = snapshot.messages.map((message) => {
    const updated = updateNode(message);
    if (updated.type !== "message") {
      throw new TreeProjectionError(
        "client_tree_node_conflict",
        `Tool result projection changed message node "${message.id}" into a non-message`,
      );
    }
    return updated;
  });
  return Object.freeze({ messages: Object.freeze(messages) });
}

export interface LocalRenderRecord<TPrepared = unknown> {
  readonly renderId: string;
  readonly parentElicitId: string;
  readonly sequence: number;
  readonly prepared: TPrepared;
}

export interface FrontendTreeProjectionOptions<TLocalRender, TPrepared> {
  readonly renders: ReadonlyMap<string, readonly LocalRenderRecord<TLocalRender>[]>;
  readonly prepare: (record: LocalRenderRecord<TLocalRender>) => TPrepared;
}

export type FrontendChatMessage<TPrepared> = RecursiveChatMessage<TPrepared>;

function overlayNode<TLocalRender, TPrepared>(
  node: HostTreeNode,
  options: FrontendTreeProjectionOptions<TLocalRender, TPrepared>,
):
  | HostTreeNode
  | RecursiveChatMessage<TPrepared>
  | RecursiveExecutionNode<TPrepared>
  | RecursiveElicitNode<TPrepared> {
  if (node.type === "message") {
    return {
      ...node,
      parts: node.parts.map((part) =>
        part.type === "tool-call"
          ? {
              ...part,
              execution: overlayNode(part.execution, options) as RecursiveExecutionNode<TPrepared>,
            }
          : part,
      ),
    } as RecursiveChatMessage<TPrepared>;
  }
  if (node.type === "execution") {
    return {
      ...node,
      children: node.children.map((child) => overlayNode(child, options)),
    } as RecursiveExecutionNode<TPrepared>;
  }
  const records = [...(options.renders.get(node.elicitId) ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  );
  return {
    ...node,
    renders: records.map(options.prepare),
  } as RecursiveElicitNode<TPrepared>;
}

/** Apply a frontend-local overlay without mutating the serializable host tree. */
export function applyFrontendOverlay<TLocalRender, TPrepared>(
  snapshot: HostChatTreeSnapshot,
  options: FrontendTreeProjectionOptions<TLocalRender, TPrepared>,
): readonly FrontendChatMessage<TPrepared>[] {
  return Object.freeze(
    snapshot.messages.map(
      (message) => overlayNode(message, options) as FrontendChatMessage<TPrepared>,
    ),
  );
}

/** Construct a safe opaque bridge for a visible descendant crossing private ancestry. */
export function createOpaqueExecutionNode(input: {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
  readonly executionId: string;
  readonly status?: RecursiveExecutionNode["status"];
}): RecursiveExecutionNode<never> {
  return Object.freeze({
    type: "execution" as const,
    placement: Object.freeze({
      nodeId: input.nodeId,
      parentNodeId: input.parentNodeId,
      sequence: input.sequence,
    }),
    executionId: input.executionId,
    presentation: "opaque" as const,
    status: input.status ?? "running",
    children: Object.freeze([]),
  });
}
