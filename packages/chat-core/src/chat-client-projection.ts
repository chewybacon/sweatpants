import { EventType, type AGUIEvent, type Message } from "@ag-ui/core";
import { parse as parsePartialJson } from "partial-json";
import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import { decodeChatContent, type ChatContentPart } from "./content.ts";
import { emptyFrame, type Frame } from "./frame.ts";
import type {
  ActivityDeltaEvent,
  ChatUIActivityPart,
  ActivitySnapshotEvent,
  ChatUIMessage,
  ChatLocalPart,
  ChatUIPart,
  ChatTransportRequestMessage,
  ClientElicitFact,
  ChatUIElicitPart,
  ChatUINestedMessagePart,
  PublicActivityData,
  PublicActivityNode,
  PublicElicitActivityNode,
  PublicToolActivityNode,
  ChatUIReasoningPart,
  ChatUIStructuredOutputPart,
  ChatUIMediaPart,
  ChatUITextPart,
  ChatUIToolCallPart,
} from "./chat-client-types.ts";
import { decodePublicActivity } from "./chat-client-codec.ts";

export type ChatProjectionErrorCode =
  | "chat_activity_invalid"
  | "chat_activity_patch_invalid"
  | "chat_activity_conflict"
  | "chat_activity_parent_missing";

export class ChatProjectionError extends Error {
  constructor(
    readonly code: ChatProjectionErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ChatProjectionError";
  }
}

interface InternalTextPart {
  readonly kind: "text" | "reasoning";
  readonly id: string;
  readonly text: string;
  readonly state: "streaming" | "done";
  readonly frame: Frame;
  readonly rendered: string;
  readonly sequence: number;
}

interface InternalStructuredOutputPartBase {
  readonly kind: "structured-output";
  readonly id: string;
  readonly raw: string;
  readonly partial?: Json;
  readonly sequence: number;
}

type InternalStructuredOutputPart =
  | (InternalStructuredOutputPartBase & {
      readonly status: "streaming";
      readonly data?: never;
      readonly errorText?: never;
    })
  | (InternalStructuredOutputPartBase & {
      readonly status: "complete";
      readonly data: Json;
      readonly errorText?: never;
    })
  | (InternalStructuredOutputPartBase & {
      readonly status: "error";
      readonly data?: never;
      readonly errorText: string;
    });

interface InternalMediaPart {
  readonly kind: "media";
  readonly id: string;
  readonly media: ChatUIMediaPart["type"];
  readonly source: ChatUIMediaPart["source"];
  readonly metadata?: Json;
  readonly sequence: number;
}

type InternalMessagePart = InternalTextPart | InternalStructuredOutputPart | InternalMediaPart;

interface InternalMessage {
  readonly id: string;
  readonly role: ChatUIMessage["role"];
  readonly metadata?: Readonly<Record<string, Json>>;
  readonly parts: readonly InternalMessagePart[];
}

/**
 * Logical parent identity. Synthetic children attach to a *message*, not to
 * whichever node happens to represent it at ingest time, so replacing a
 * provisional message node by its authoritative placement requires no child
 * migration: resolution simply starts answering differently.
 */
type ParentRef =
  | { readonly kind: "root" }
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "message"; readonly messageId: string };

interface InternalNode {
  /** `parentNodeId` is the resolved physical parent as of the last refresh. */
  readonly node: PublicActivityNode;
  readonly parentRef: ParentRef;
  readonly activityRecordId: string;
  readonly synthetic: boolean;
}

export type ChatProjectionAction =
  | {
      readonly type: "text-changed";
      readonly messageId: string;
      readonly kind: "text" | "reasoning";
      readonly delta: string;
      readonly done: boolean;
    }
  | { readonly type: "elicit-observed"; readonly request: ClientElicitFact }
  | { readonly type: "elicit-settled"; readonly elicitId: string }
  | { readonly type: "elicit-cancelled"; readonly elicitId: string };

export interface ChatProjectionTransition {
  readonly projection: ChatProjectionState;
  readonly actions: readonly ChatProjectionAction[];
}

export interface ChatProjectionState {
  /** Fact store: node records with logical parents; resolved on refresh. */
  readonly nodes: ReadonlyMap<string, InternalNode>;
  /** Core state: message content, arrival order, streaming cursors. */
  readonly messageById: ReadonlyMap<string, InternalMessage>;
  readonly messageOrder: readonly string[];
  readonly structuredOutputByMessageId: ReadonlyMap<string, string>;
  readonly nextSequence: number;
  readonly error: Error | null;
  /** Alias registry: activity record id → node id, written only on upsert. */
  readonly activityNodeByRecordId: ReadonlyMap<string, string>;
  /** Derived indexes, recomputed from `nodes` whenever a record is inserted. */
  readonly messageNodeById: ReadonlyMap<string, string>;
  readonly toolNodeByCallId: ReadonlyMap<string, string>;
  readonly elicitNodeById: ReadonlyMap<string, string>;
  readonly attachedChildren: ReadonlyMap<string, readonly string[]>;
  readonly pendingChildren: ReadonlyMap<string, readonly string[]>;
}

export function createChatProjection(): ChatProjectionState {
  return {
    nodes: new Map(),
    messageById: new Map(),
    messageNodeById: new Map(),
    toolNodeByCallId: new Map(),
    elicitNodeById: new Map(),
    activityNodeByRecordId: new Map(),
    attachedChildren: new Map(),
    pendingChildren: new Map(),
    messageOrder: [],
    structuredOutputByMessageId: new Map(),
    nextSequence: 0,
    error: null,
  };
}

function mapCopy<T>(map: ReadonlyMap<string, T>): Map<string, T> {
  return new Map(map);
}

/**
 * Resolve a tool call to its node, tolerating a not-yet-refreshed index so a
 * tool inserted earlier in the same fold batch is still addressable.
 */
function toolNodeIdFor(state: ChatProjectionState, callId: string): string | undefined {
  const indexed = state.toolNodeByCallId.get(callId);
  if (indexed !== undefined && state.nodes.has(indexed)) {
    return indexed;
  }
  return state.nodes.has(`execution:${callId}`) ? `execution:${callId}` : undefined;
}

function nodeImmutable(node: PublicActivityNode): string {
  const data = node.publicData;
  let immutableData: Json | undefined;
  if (data?.kind === "message") {
    immutableData = { kind: data.kind, messageId: data.messageId, role: data.role };
  } else if (data?.kind === "tool-call") {
    immutableData = { kind: data.kind, callId: data.callId, name: data.name };
  } else if (data?.kind === "activity") {
    immutableData = { kind: data.kind, activityType: data.activityType };
  } else if (data?.kind === "elicit") {
    immutableData = {
      kind: data.kind,
      elicitId: data.elicitId,
      bindingId: data.bindingId,
      key: data.key,
      message: data.message,
      ...(data.context !== undefined ? { context: data.context } : {}),
      responseContract: data.responseContract as unknown as Json,
      ...(data.contextContract !== undefined
        ? { contextContract: data.contextContract as unknown as Json }
        : {}),
      toolName: data.toolName,
      callId: data.callId,
      producerSequence: data.producerSequence,
    };
  }
  return canonicalJson({
    nodeId: node.nodeId,
    parentNodeId: node.parentNodeId,
    sequence: node.sequence,
    kind: node.kind,
    presentation: node.presentation,
    ...(immutableData !== undefined ? { publicData: immutableData } : {}),
  });
}

function cloneNodeWithMutable(
  previous: PublicActivityNode,
  incoming: PublicActivityNode,
): PublicActivityNode {
  const terminalElicit =
    previous.kind === "elicit" &&
    (previous.state === "responded" || previous.state === "cancelled");
  return {
    ...previous,
    state: terminalElicit ? previous.state : incoming.state,
    ...(incoming.publicData !== undefined ? { publicData: incoming.publicData } : {}),
  } as PublicActivityNode;
}

function preserveSettledToolResult(
  previous: PublicActivityNode,
  incoming: PublicActivityNode,
): PublicActivityNode {
  if (
    previous.kind !== "tool-call" ||
    incoming.kind !== "tool-call" ||
    (previous.state !== "output-available" && previous.state !== "output-error") ||
    previous.publicData?.kind !== "tool-call" ||
    incoming.publicData?.kind !== "tool-call"
  ) {
    return incoming;
  }
  const prior = previous.publicData;
  return {
    ...incoming,
    state: previous.state,
    publicData: {
      ...incoming.publicData,
      ...(prior.output !== undefined ? { output: prior.output } : {}),
      ...(prior.errorText !== undefined ? { errorText: prior.errorText } : {}),
    },
  };
}

/**
 * Recompute every index derived from the node fact store: authoritative
 * message claims shadow synthetic placeholders, logical parents resolve to
 * physical node ids, children partition into attached and pending, and
 * sibling-sequence conflicts are rejected on the event that created them.
 */
function refreshDerivedState(state: ChatProjectionState): ChatProjectionState {
  // Pass 1: message claims. A synthetic node cannot be known to be shadowed
  // until every node has been seen, so this genuinely precedes resolution.
  const messageNodeById = new Map<string, string>();
  const authoritative = new Map<string, string>();
  for (const [nodeId, entry] of state.nodes) {
    const data = entry.node.publicData;
    if (data?.kind !== "message") continue;
    if (entry.synthetic) {
      if (!messageNodeById.has(data.messageId)) messageNodeById.set(data.messageId, nodeId);
    } else {
      authoritative.set(data.messageId, nodeId);
    }
  }
  for (const [messageId, nodeId] of authoritative) {
    messageNodeById.set(messageId, nodeId);
  }

  // Pass 2: resolve parents and collect every index that shares this walk.
  // These are not independent accumulators — they all consume the resolved
  // node — so one loop is correct here, not a combined fold.
  const nodes = new Map<string, InternalNode>();
  const toolNodeByCallId = new Map<string, string>();
  const elicitNodeById = new Map<string, string>();
  const edges: (readonly [string, string])[] = [];
  for (const [nodeId, entry] of state.nodes) {
    const data = entry.node.publicData;
    if (
      entry.synthetic &&
      data?.kind === "message" &&
      messageNodeById.get(data.messageId) !== nodeId
    ) {
      // Shadowed by an authoritative placement: content lives in messageById
      // and children re-resolve through their message reference.
      continue;
    }
    const ref = entry.parentRef;
    const parentNodeId =
      ref.kind === "root"
        ? null
        : ref.kind === "node"
          ? ref.nodeId
          : (messageNodeById.get(ref.messageId) ?? `message:${ref.messageId}`);
    nodes.set(
      nodeId,
      entry.node.parentNodeId === parentNodeId
        ? entry
        : { ...entry, node: { ...entry.node, parentNodeId } as PublicActivityNode },
    );
    if (data?.kind === "tool-call") {
      toolNodeByCallId.set(data.callId, nodeId);
    } else if (data?.kind === "elicit") {
      elicitNodeById.set(data.elicitId, nodeId);
    }
    if (parentNodeId !== null) {
      edges.push([parentNodeId, nodeId]);
    }
  }

  // Pass 3: partition edges, which needs the completed node set.
  const attachedChildren = new Map<string, string[]>();
  const pendingChildren = new Map<string, string[]>();
  for (const [parentId, nodeId] of edges) {
    const bucket = nodes.has(parentId) ? attachedChildren : pendingChildren;
    const list = bucket.get(parentId);
    if (list) list.push(nodeId);
    else bucket.set(parentId, [nodeId]);
  }

  for (const [parentId, children] of attachedChildren) {
    const occupied = new Set<number>();
    for (const childId of children) {
      const sequence = nodes.get(childId)!.node.sequence;
      if (occupied.has(sequence)) {
        throw new ChatProjectionError(
          "chat_activity_conflict",
          `Sibling sequence ${sequence} is already occupied under parent "${parentId}"`,
        );
      }
      occupied.add(sequence);
    }
  }

  return {
    ...state,
    nodes,
    messageNodeById,
    toolNodeByCallId,
    elicitNodeById,
    attachedChildren,
    pendingChildren,
  };
}

/** The entire structural fold: validate immutable facts, merge, store. */
function upsertGraphNode(
  state: ChatProjectionState,
  node: PublicActivityNode,
  activityRecordId: string,
  parentRef: ParentRef,
  synthetic = false,
): ChatProjectionState {
  const existingRecord = state.activityNodeByRecordId.get(activityRecordId);
  if (existingRecord !== undefined && existingRecord !== node.nodeId) {
    throw new ChatProjectionError(
      "chat_activity_conflict",
      `Activity record "${activityRecordId}" changed node identity`,
    );
  }
  const activityNodeByRecordId = new Map(state.activityNodeByRecordId).set(
    activityRecordId,
    node.nodeId,
  );
  const existing = state.nodes.get(node.nodeId);
  if (existing) {
    if (nodeImmutable(existing.node) !== nodeImmutable(node) && !existing.synthetic) {
      throw new ChatProjectionError(
        "chat_activity_conflict",
        `Node "${node.nodeId}" was reused with conflicting immutable facts`,
      );
    }
    const merged =
      existing.synthetic && !synthetic
        ? preserveSettledToolResult(existing.node, node)
        : cloneNodeWithMutable(existing.node, node);
    const nodes = mapCopy(state.nodes);
    nodes.set(node.nodeId, {
      // Attachment identity is stable across merges: the already-resolved
      // parent wins so a merge never silently re-parents a rendered subtree.
      node: { ...merged, parentNodeId: existing.node.parentNodeId } as PublicActivityNode,
      parentRef: existing.parentRef,
      activityRecordId,
      synthetic: existing.synthetic && synthetic,
    });
    return { ...state, nodes, activityNodeByRecordId };
  }
  const nodes = mapCopy(state.nodes);
  nodes.set(node.nodeId, { node, parentRef, activityRecordId, synthetic });
  return {
    ...state,
    nodes,
    activityNodeByRecordId,
    nextSequence: Math.max(state.nextSequence, node.sequence + 1),
  };
}

function ensureMessage(
  state: ChatProjectionState,
  messageId: string,
  role: ChatUIMessage["role"],
): ChatProjectionState {
  const existing = state.messageById.get(messageId);
  if (existing) {
    if (existing.role !== role) {
      throw new ChatProjectionError(
        "chat_activity_conflict",
        `Message "${messageId}" changed role`,
      );
    }
    return state;
  }
  const nodeId = `message:${messageId}`;
  const next = state.messageNodeById.has(messageId)
    ? state
    : upsertGraphNode(
        state,
        {
          nodeId,
          parentNodeId: null,
          sequence: state.nextSequence,
          kind: "message",
          state: "streaming",
          presentation: "public",
          publicData: { kind: "message", messageId, role },
        },
        nodeId,
        { kind: "root" },
        true,
      );
  const messageById = mapCopy(next.messageById);
  messageById.set(messageId, { id: messageId, role, parts: [] });
  const messageOrder = next.messageOrder.includes(messageId)
    ? next.messageOrder
    : [...next.messageOrder, messageId];
  return { ...next, messageById, messageOrder, nextSequence: next.nextSequence + 1 };
}

function ensureMessageFromActivity(
  state: ChatProjectionState,
  node: PublicActivityNode,
): ChatProjectionState {
  if (node.publicData?.kind !== "message") {
    return state;
  }
  const messageId = node.publicData.messageId;
  const existing = state.messageById.get(messageId);
  let next = upsertGraphNode(
    state,
    node,
    node.nodeId,
    node.parentNodeId === null ? { kind: "root" } : { kind: "node", nodeId: node.parentNodeId },
    false,
  );
  if (!existing) {
    const messageById = mapCopy(next.messageById);
    messageById.set(messageId, { id: messageId, role: node.publicData.role, parts: [] });
    const messageOrder =
      node.parentNodeId === null && !next.messageOrder.includes(messageId)
        ? [...next.messageOrder, messageId]
        : next.messageOrder;
    next = { ...next, messageById, messageOrder };
  }
  return next;
}

function latestMessageId(
  state: ChatProjectionState,
  role?: ChatUIMessage["role"],
): string | undefined {
  for (let index = state.messageOrder.length - 1; index >= 0; index -= 1) {
    const id = state.messageOrder[index]!;
    const message = state.messageById.get(id);
    if (message && (role === undefined || message.role === role)) {
      return id;
    }
  }
  return undefined;
}

function updateMessage(
  state: ChatProjectionState,
  messageId: string,
  updater: (message: InternalMessage) => InternalMessage,
): ChatProjectionState {
  const message = state.messageById.get(messageId);
  if (!message) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Message "${messageId}" is not registered`,
    );
  }
  const messages = mapCopy(state.messageById);
  messages.set(messageId, updater(message));
  return { ...state, messageById: messages };
}

function contentPart(
  state: ChatProjectionState,
  messageId: string,
  kind: "text" | "reasoning",
  delta: string,
): ChatProjectionState {
  const known = state.messageById.get(messageId);
  let next = ensureMessage(state, messageId, known?.role ?? "assistant");
  const message = next.messageById.get(messageId)!;
  const parts = [...message.parts];
  let index = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i]!.kind === kind) {
      index = i;
      break;
    }
    if (parts[i]!.kind !== kind) {
      break;
    }
  }
  const existing = index >= 0 ? parts[index] : undefined;
  const existingText =
    existing?.kind === "text" || existing?.kind === "reasoning" ? existing : undefined;
  if (index < 0 || existing?.kind !== kind || existingText?.state === "done") {
    parts.push({
      kind,
      id: `${messageId}:${kind}:${next.nextSequence}`,
      text: "",
      state: "streaming",
      frame: emptyFrame(),
      rendered: "",
      sequence: next.nextSequence,
    });
    index = parts.length - 1;
    next = { ...next, nextSequence: next.nextSequence + 1 };
  }
  const current = parts[index]!;
  if (current.kind === "structured-output" || current.kind === "media") {
    throw new ChatProjectionError(
      "chat_activity_conflict",
      `Text content for message "${messageId}" points at structured output`,
    );
  }
  parts[index] = { ...current, text: current.text + delta };
  return updateMessage(next, messageId, (value) => ({ ...value, parts }));
}

function startContent(
  state: ChatProjectionState,
  messageId: string,
  kind: "text" | "reasoning",
): ChatProjectionState {
  const known = state.messageById.get(messageId);
  let next = ensureMessage(state, messageId, known?.role ?? "assistant");
  const message = next.messageById.get(messageId)!;
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  const lastDone =
    last !== undefined &&
    (last.kind === "text" || last.kind === "reasoning") &&
    last.state === "done";
  if (!last || last.kind !== kind || lastDone) {
    parts.push({
      kind,
      id: `${messageId}:${kind}:${next.nextSequence}`,
      text: "",
      state: "streaming",
      frame: emptyFrame(),
      rendered: "",
      sequence: next.nextSequence,
    });
    next = { ...next, nextSequence: next.nextSequence + 1 };
  }
  return updateMessage(next, messageId, (value) => ({ ...value, parts }));
}

function endContent(
  state: ChatProjectionState,
  messageId: string,
  kind: "text" | "reasoning",
): ChatProjectionState {
  return updateMessage(state, messageId, (message) => {
    const parts = message.parts.map((part) =>
      part.kind === kind && part.state === "streaming" ? { ...part, state: "done" as const } : part,
    );
    return { ...message, parts };
  });
}

function parseStructuredOutputPartial(raw: string): Json | undefined {
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    return assertJson(parsePartialJson(raw));
  } catch {
    return undefined;
  }
}

function structuredOutputPart(
  state: ChatProjectionState,
  messageId: string,
):
  | {
      readonly message: InternalMessage;
      readonly index: number;
      readonly part: InternalStructuredOutputPart;
    }
  | undefined {
  const partId = state.structuredOutputByMessageId.get(messageId);
  if (!partId) {
    return undefined;
  }
  const message = state.messageById.get(messageId);
  if (!message) {
    return undefined;
  }
  const index = message.parts.findIndex(
    (part): part is InternalStructuredOutputPart =>
      part.kind === "structured-output" && part.id === partId,
  );
  const part = index >= 0 ? message.parts[index] : undefined;
  return part?.kind === "structured-output" ? { message, index, part } : undefined;
}

function startStructuredOutput(state: ChatProjectionState, messageId: string): ChatProjectionState {
  let next = ensureMessage(state, messageId, "assistant");
  const active = structuredOutputPart(next, messageId);
  if (active?.part.status === "streaming") {
    return next;
  }
  const message = next.messageById.get(messageId)!;
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last?.kind === "text" && last.state === "streaming" && last.text.length === 0) {
    parts.pop();
  }
  const part: InternalStructuredOutputPart = {
    kind: "structured-output",
    id: `${messageId}:structured-output:${next.nextSequence}`,
    status: "streaming",
    raw: "",
    sequence: next.nextSequence,
  };
  parts.push(part);
  const structuredOutputByMessageId = mapCopy(next.structuredOutputByMessageId);
  structuredOutputByMessageId.set(messageId, part.id);
  next = {
    ...next,
    structuredOutputByMessageId,
    nextSequence: next.nextSequence + 1,
  };
  return updateMessage(next, messageId, (value) => ({ ...value, parts }));
}

function appendStructuredOutput(
  state: ChatProjectionState,
  messageId: string,
  delta: string,
): ChatProjectionState {
  const active = structuredOutputPart(state, messageId);
  if (!active) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Structured output for message "${messageId}" has no start event`,
    );
  }
  if (active.part.status !== "streaming") {
    throw new ChatProjectionError(
      "chat_activity_conflict",
      `Structured output for message "${messageId}" received content after ${active.part.status}`,
    );
  }
  const raw = active.part.raw + delta;
  const partial = parseStructuredOutputPartial(raw);
  return updateMessage(state, messageId, (message) => {
    const parts = [...message.parts];
    parts[active.index] = {
      ...active.part,
      raw,
      ...(partial !== undefined ? { partial } : {}),
    };
    return { ...message, parts };
  });
}

function completeStructuredOutput(
  state: ChatProjectionState,
  messageId: string,
  value: { readonly object: Json; readonly raw: string },
): ChatProjectionState {
  let next = ensureMessage(state, messageId, "assistant");
  const active = structuredOutputPart(next, messageId);
  const partial = parseStructuredOutputPartial(value.raw) ?? value.object;
  if (active?.part.status === "complete") {
    if (
      canonicalJson(active.part.data) !== canonicalJson(value.object) ||
      active.part.raw !== value.raw
    ) {
      throw new ChatProjectionError(
        "chat_activity_conflict",
        `Structured output for message "${messageId}" was completed with conflicting data`,
      );
    }
    return next;
  }
  if (active && active.part.status === "error") {
    throw new ChatProjectionError(
      "chat_activity_conflict",
      `Structured output for message "${messageId}" was completed after an error`,
    );
  }
  const message = next.messageById.get(messageId)!;
  const part: InternalStructuredOutputPart = {
    kind: "structured-output",
    id: active?.part.id ?? `${messageId}:structured-output:${next.nextSequence}`,
    status: "complete",
    raw: value.raw,
    partial,
    data: value.object,
    sequence: active?.part.sequence ?? next.nextSequence,
  };
  const parts = [...message.parts];
  if (active) {
    parts[active.index] = part;
  } else {
    parts.push(part);
    next = { ...next, nextSequence: next.nextSequence + 1 };
  }
  const structuredOutputByMessageId = mapCopy(next.structuredOutputByMessageId);
  structuredOutputByMessageId.delete(messageId);
  next = { ...next, structuredOutputByMessageId };
  return updateMessage(next, messageId, () => ({ ...message, parts }));
}

function errorStructuredOutput(
  state: ChatProjectionState,
  messageId: string,
  errorText: string,
): ChatProjectionState {
  const active = structuredOutputPart(state, messageId);
  if (!active) {
    return state;
  }
  if (active.part.status === "complete") {
    return state;
  }
  const parts = [...active.message.parts];
  parts[active.index] = {
    ...active.part,
    status: "error",
    errorText,
  };
  const structuredOutputByMessageId = mapCopy(state.structuredOutputByMessageId);
  structuredOutputByMessageId.delete(messageId);
  return updateMessage({ ...state, structuredOutputByMessageId }, messageId, (message) => ({
    ...message,
    parts,
  }));
}

function errorActiveStructuredOutputs(
  state: ChatProjectionState,
  errorText: string,
): ChatProjectionState {
  let next = state;
  for (const messageId of state.structuredOutputByMessageId.keys()) {
    next = errorStructuredOutput(next, messageId, errorText);
  }
  return next;
}

function toolNode(
  state: ChatProjectionState,
  callId: string,
  name: string,
  parentMessageId?: string,
): ChatProjectionState {
  if (toolNodeIdFor(state, callId) !== undefined) {
    return state;
  }
  const messageId = parentMessageId ?? latestMessageId(state, "assistant");
  if (!messageId) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Tool call "${callId}" has no parent message`,
    );
  }
  const next = ensureMessage(state, messageId, "assistant");
  const nodeId = `execution:${callId}`;
  const node: PublicActivityNode = {
    nodeId,
    parentNodeId: next.messageNodeById.get(messageId) ?? `message:${messageId}`,
    sequence: next.nextSequence,
    kind: "tool-call",
    state: "input-streaming",
    presentation: "public",
    publicData: { kind: "tool-call", callId, name, rawInput: "" },
  };
  const inserted = upsertGraphNode(next, node, nodeId, { kind: "message", messageId }, true);
  return { ...inserted, nextSequence: inserted.nextSequence + 1 };
}

function updateTool(
  state: ChatProjectionState,
  callId: string,
  update: (node: PublicToolActivityNode) => PublicToolActivityNode,
): ChatProjectionState {
  const nodeId = toolNodeIdFor(state, callId);
  if (!nodeId) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Tool call "${callId}" is not registered`,
    );
  }
  const current = state.nodes.get(nodeId)!;
  if (current.node.kind !== "tool-call") {
    throw new ChatProjectionError(
      "chat_activity_conflict",
      `Tool call "${callId}" points to a ${current.node.kind} node`,
    );
  }
  const nodes = mapCopy(state.nodes);
  nodes.set(nodeId, { ...current, node: update(current.node) });
  return { ...state, nodes };
}

function activityNode(
  state: ChatProjectionState,
  event: ActivitySnapshotEvent,
): ChatProjectionState {
  if (event.activityType !== "sweatpants:public-execution") {
    const parentMessageId =
      (state.messageById.has(event.messageId) ? event.messageId : undefined) ??
      latestMessageId(state, "assistant") ??
      latestMessageId(state);
    let next = state;
    if (parentMessageId !== undefined && !next.messageNodeById.has(parentMessageId)) {
      next = ensureMessage(next, parentMessageId, "assistant");
    }
    const nodeId = `activity:${event.messageId}`;
    const node: PublicActivityNode = {
      nodeId,
      parentNodeId:
        parentMessageId === undefined
          ? null
          : (next.messageNodeById.get(parentMessageId) ?? `message:${parentMessageId}`),
      sequence: next.nextSequence,
      kind: "activity",
      state: "running",
      presentation: "public",
      publicData: {
        kind: "activity",
        activityType: event.activityType,
        data: event.content,
      },
    };
    return upsertGraphNode(
      next,
      node,
      event.messageId,
      parentMessageId === undefined
        ? { kind: "root" }
        : { kind: "message", messageId: parentMessageId },
    );
  }
  const activity = decodePublicActivity(event.content);
  const next = ensureMessageFromActivity(state, activity.node);
  return upsertGraphNode(
    next,
    activity.node,
    event.messageId,
    activity.node.parentNodeId === null
      ? { kind: "root" }
      : { kind: "node", nodeId: activity.node.parentNodeId },
    false,
  );
}

function applyPatchToNode(node: PublicActivityNode, event: ActivityDeltaEvent): PublicActivityNode {
  let next = node;
  const states = new Set<PublicActivityNode["state"]>([
    "streaming",
    "done",
    "input-streaming",
    "input-available",
    "output-available",
    "output-error",
    "running",
    "complete",
    "error",
    "cancelled",
    "pending",
    "responded",
  ]);
  for (const patch of event.patch) {
    if (patch.op !== "add" && patch.op !== "remove" && patch.op !== "replace") {
      throw new ChatProjectionError(
        "chat_activity_patch_invalid",
        `Patch operation ${patch.op} is not allowed for public activity`,
      );
    }
    const value = patch.value;
    if (patch.path === "/node/state") {
      if (typeof value !== "string" || !states.has(value as PublicActivityNode["state"])) {
        throw new ChatProjectionError(
          "chat_activity_patch_invalid",
          "node state patch must be a string",
        );
      }
      next = { ...next, state: value as PublicActivityNode["state"] } as PublicActivityNode;
      continue;
    }
    const data = next.publicData;
    if (!data) {
      throw new ChatProjectionError(
        "chat_activity_patch_invalid",
        "publicData patch has no publicData",
      );
    }
    if (
      data.kind === "tool-call" &&
      ["rawInput", "input", "output", "errorText"].some(
        (key) => patch.path === `/node/publicData/${key}`,
      )
    ) {
      const key = patch.path.slice("/node/publicData/".length) as
        | "rawInput"
        | "input"
        | "output"
        | "errorText";
      const updated = { ...data } as unknown as Record<string, unknown>;
      if (patch.op === "remove") {
        delete updated[key];
      } else {
        if (
          value === undefined ||
          ((key === "rawInput" || key === "errorText") && typeof value !== "string")
        ) {
          throw new ChatProjectionError(
            "chat_activity_patch_invalid",
            `Patch ${patch.path} requires a value`,
          );
        }
        updated[key] = value;
      }
      next = {
        ...next,
        publicData: updated as unknown as PublicActivityData,
      } as PublicActivityNode;
      continue;
    }
    if (data.kind === "activity" && patch.path === "/node/publicData/data") {
      const updated = { ...data } as unknown as Record<string, unknown>;
      if (patch.op === "remove") {
        delete updated["data"];
      } else {
        if (value === undefined) {
          throw new ChatProjectionError(
            "chat_activity_patch_invalid",
            "Activity data patch requires a value",
          );
        }
        updated["data"] = value;
      }
      next = {
        ...next,
        publicData: updated as unknown as PublicActivityData,
      } as PublicActivityNode;
      continue;
    }
    throw new ChatProjectionError(
      "chat_activity_patch_invalid",
      `Patch ${patch.path} is not valid for node kind ${data.kind}`,
    );
  }
  try {
    return decodePublicActivity({ version: 1, node: next }).node;
  } catch (error) {
    throw new ChatProjectionError(
      "chat_activity_patch_invalid",
      error instanceof Error ? error.message : "Activity patch produced an invalid node",
    );
  }
}

function activityDelta(state: ChatProjectionState, event: ActivityDeltaEvent): ChatProjectionState {
  const nodeId = state.activityNodeByRecordId.get(event.messageId);
  if (!nodeId) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Activity record "${event.messageId}" is not registered`,
    );
  }
  const current = state.nodes.get(nodeId);
  if (!current) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Activity node "${nodeId}" is not registered`,
    );
  }
  const nodes = mapCopy(state.nodes);
  nodes.set(nodeId, { ...current, node: applyPatchToNode(current.node, event) });
  return { ...state, nodes };
}

function wireMediaPart(value: unknown): ChatContentPart | undefined {
  try {
    const decoded = decodeChatContent([value]);
    if (typeof decoded === "string") return undefined;
    return decoded[0];
  } catch {
    return undefined;
  }
}

function appendMediaPart(
  state: ChatProjectionState,
  messageId: string,
  input: Exclude<ChatContentPart, { readonly type: "text" }>,
): ChatProjectionState {
  let next = ensureMessage(state, messageId, "user");
  const message = next.messageById.get(messageId)!;
  const duplicate = message.parts.some(
    (part) =>
      part.kind === "media" &&
      canonicalJson({
        type: part.media,
        source: part.source,
        metadata: part.metadata ?? null,
      }) === canonicalJson(input),
  );
  if (duplicate) {
    return next;
  }
  const media: InternalMediaPart = {
    kind: "media",
    id: `${messageId}:${input.type}:${next.nextSequence}`,
    media: input.type,
    source: input.source,
    ...(input.metadata !== null ? { metadata: input.metadata } : {}),
    sequence: next.nextSequence,
  };
  next = { ...next, nextSequence: next.nextSequence + 1 };
  return updateMessage(next, messageId, (value) => ({ ...value, parts: [...value.parts, media] }));
}

function appendWireContent(
  state: ChatProjectionState,
  messageId: string,
  role: ChatUIMessage["role"],
  value: unknown,
): ChatProjectionState {
  if (!Array.isArray(value)) {
    const text = wireContent(value);
    if (text === undefined || text.length === 0) {
      return state;
    }
    const message = state.messageById.get(messageId);
    if (message?.parts.some((part) => part.kind === "text" && part.text === text)) {
      return state;
    }
    let next = startContent(ensureMessage(state, messageId, role), messageId, "text");
    next = contentPart(next, messageId, "text", text);
    return endContent(next, messageId, "text");
  }
  let next = state;
  for (const rawPart of value) {
    const part = wireMediaPart(rawPart);
    if (!part) {
      continue;
    }
    if (part.type === "text") {
      const message = next.messageById.get(messageId);
      if (message?.parts.some((entry) => entry.kind === "text" && entry.text === part.text)) {
        continue;
      }
      next = startContent(ensureMessage(next, messageId, role), messageId, "text");
      next = contentPart(next, messageId, "text", part.text);
      next = endContent(next, messageId, "text");
    } else {
      next = appendMediaPart(next, messageId, part);
    }
  }
  return next;
}

function wireContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("");
  }
  return undefined;
}

function chatRole(role: Message["role"]): ChatUIMessage["role"] | undefined {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  if (role === "developer") {
    return "system";
  }
  return undefined;
}

function messageToWire<TLocalPart extends ChatLocalPart>(
  message: ChatUIMessage<TLocalPart>,
): ChatTransportRequestMessage {
  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [(part as ChatUITextPart).text];
      }
      if (part.type === "structured-output") {
        return [(part as ChatUIStructuredOutputPart).raw];
      }
      return [];
    })
    .join("");
  const contentParts: ChatContentPart[] = message.parts.flatMap((part): ChatContentPart[] => {
    if (part.type === "text") {
      return [{ type: "text", text: (part as ChatUITextPart).text }];
    }
    if (
      (part.type === "image" ||
        part.type === "audio" ||
        part.type === "video" ||
        part.type === "document") &&
      "source" in part
    ) {
      return [
        {
          type: part.type,
          source: part.source,
          metadata: part.metadata ?? null,
        },
      ];
    }
    return [];
  });
  const hasMedia = contentParts.some((part) => part.type !== "text");
  const toolCalls = message.parts
    .filter(
      (part): part is ChatUIToolCallPart<TLocalPart> =>
        part.type === "tool-call" && "callId" in part,
    )
    .map((part) => ({
      id: part.callId,
      type: "function" as const,
      function: {
        name: part.name,
        arguments: part.rawInput ?? JSON.stringify(part.input ?? {}),
      },
    }));
  if (message.role === "user" || message.role === "system") {
    return {
      id: message.id,
      role: message.role,
      content: message.role === "user" && hasMedia ? contentParts : text,
    } as Extract<ChatTransportRequestMessage, { role: "user" | "system" }>;
  }
  return {
    id: message.id,
    role: "assistant",
    ...(text.length > 0 ? { content: text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Project public root messages back to provider-facing AG-UI history. */
export function projectChatMessagesToAGUI<TLocalPart extends ChatLocalPart>(
  messages: readonly ChatUIMessage<TLocalPart>[],
): readonly ChatTransportRequestMessage[] {
  return messages.flatMap((message) => {
    const wire = messageToWire(message);
    if (message.role !== "assistant") {
      return [wire];
    }
    const results: ChatTransportRequestMessage[] = message.parts.flatMap(
      (part): ChatTransportRequestMessage[] => {
        if (part.type !== "tool-call" || !("callId" in part)) {
          return [];
        }
        const toolCall = part;
        if (toolCall.state === "output-available") {
          const content =
            typeof toolCall.output === "string"
              ? toolCall.output
              : JSON.stringify(toolCall.output ?? null);
          return [
            {
              id: `tool-result:${toolCall.callId}`,
              role: "tool" as const,
              toolCallId: toolCall.callId,
              name: toolCall.name,
              content,
              isError: false,
            },
          ];
        }
        if (toolCall.state === "output-error") {
          return [
            {
              id: `tool-result:${toolCall.callId}`,
              role: "tool" as const,
              toolCallId: toolCall.callId,
              name: toolCall.name,
              content: toolCall.errorText ?? "Tool execution failed",
              isError: true,
              error: toolCall.errorText ?? "Tool execution failed",
            },
          ];
        }
        return [];
      },
    );
    return [wire, ...results];
  });
}

function appendMessageCore(state: ChatProjectionState, message: Message): ChatProjectionState {
  if (message.role === "tool") {
    const nodeId = toolNodeIdFor(state, message.toolCallId);
    const content = wireContent(message.content) ?? "";
    return nodeId === undefined
      ? state
      : updateTool(state, message.toolCallId, (node) => {
          const data = node.publicData;
          return {
            ...node,
            state: message.error === undefined ? "output-available" : "output-error",
            publicData:
              message.error === undefined
                ? { ...data, output: parseJsonOrString(content) }
                : {
                    ...data,
                    errorText: typeof message.error === "string" ? message.error : content,
                  },
          };
        });
  }
  const role = chatRole(message.role);
  if (role === undefined) {
    return state;
  }
  let next = ensureMessage(state, message.id, role);
  next = appendWireContent(next, message.id, role, message.content);
  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      next = toolNode(next, call.id, call.function.name, message.id);
      next = updateTool(next, call.id, (node) => ({
        ...node,
        state: "input-available",
        publicData: {
          kind: "tool-call",
          callId: call.id,
          name: call.function.name,
          rawInput: call.function.arguments,
          input: parseJsonOrString(call.function.arguments),
        },
      }));
    }
  }
  return next;
}

function parseJsonOrString(value: string): Json {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

export function appendAGUIMessage(
  state: ChatProjectionState,
  message: Message,
): ChatProjectionState {
  const next = appendMessageCore(state, message);
  return next.nodes.size > state.nodes.size ? refreshDerivedState(next) : next;
}

/**
 * Append many messages, deriving once. Per-message appends each pay a full
 * derivation, so seeding a window one message at a time is quadratic.
 */
export function appendAGUIMessages(
  state: ChatProjectionState,
  messages: Iterable<Message>,
): ChatProjectionState {
  let next = state;
  for (const message of messages) {
    next = appendMessageCore(next, message);
  }
  return next.nodes.size > state.nodes.size ? refreshDerivedState(next) : next;
}

/**
 * Fold one AG-UI event. Content deltas leave the node fact store untouched and
 * cost O(1); events that insert node records trigger one O(n) index refresh.
 */
export function foldAGUIEvent(state: ChatProjectionState, event: AGUIEvent): ChatProjectionState {
  const next = foldEventCore(state, event);
  return next.nodes.size > state.nodes.size ? refreshDerivedState(next) : next;
}

/**
 * Fold a batch of events, deriving once at the end.
 *
 * Safe because parent references are logical: a mid-batch read of
 * `messageNodeById` may be stale, but the value it feeds is only a placeholder
 * `parentNodeId` that the final derivation overwrites from `parentRef`.
 */
export function foldAGUIEvents(
  state: ChatProjectionState,
  events: Iterable<AGUIEvent>,
): ChatProjectionState {
  let next = state;
  for (const event of events) {
    next = foldEventCore(next, event);
  }
  return next.nodes.size > state.nodes.size ? refreshDerivedState(next) : next;
}

function foldEventCore(state: ChatProjectionState, event: AGUIEvent): ChatProjectionState {
  switch (event.type) {
    case EventType.MESSAGES_SNAPSHOT:
      return appendAGUIMessages(createChatProjection(), event.messages);
    case EventType.TEXT_MESSAGE_START: {
      if (state.structuredOutputByMessageId.has(event.messageId)) {
        return state;
      }
      const role = chatRole(event.role);
      return role === undefined
        ? state
        : startContent(ensureMessage(state, event.messageId, role), event.messageId, "text");
    }
    case EventType.TEXT_MESSAGE_CONTENT:
      return state.structuredOutputByMessageId.has(event.messageId)
        ? appendStructuredOutput(state, event.messageId, event.delta)
        : contentPart(state, event.messageId, "text", event.delta);
    case EventType.TEXT_MESSAGE_END:
      return endContent(state, event.messageId, "text");
    case EventType.REASONING_MESSAGE_START:
      return startContent(
        ensureMessage(state, event.messageId, "assistant"),
        event.messageId,
        "reasoning",
      );
    case EventType.REASONING_MESSAGE_CONTENT:
      return contentPart(state, event.messageId, "reasoning", event.delta);
    case EventType.REASONING_MESSAGE_END:
      return endContent(state, event.messageId, "reasoning");
    case EventType.CUSTOM: {
      if (event.name === "structured-output.start") {
        const value = event.value as { readonly messageId: string };
        return startStructuredOutput(state, value.messageId);
      }
      if (event.name === "structured-output.complete") {
        const value = event.value as {
          readonly messageId?: string;
          readonly object: Json;
          readonly raw: string;
        };
        const messageId = value.messageId ?? latestMessageId(state, "assistant");
        if (!messageId) {
          throw new ChatProjectionError(
            "chat_activity_parent_missing",
            "Structured output complete event has no assistant message",
          );
        }
        return completeStructuredOutput(state, messageId, value);
      }
      return state;
    }
    case EventType.RUN_ERROR:
      return errorActiveStructuredOutputs(state, event.message);
    case EventType.RUN_FINISHED:
      return errorActiveStructuredOutputs(
        state,
        "Structured output stream ended before completion",
      );
    case EventType.TOOL_CALL_START:
      return toolNode(state, event.toolCallId, event.toolCallName, event.parentMessageId);
    case EventType.TOOL_CALL_ARGS: {
      return updateTool(state, event.toolCallId, (node) => {
        const data = node.publicData;
        const { input: _input, output: _output, errorText: _errorText, ...base } = data;
        return {
          ...node,
          state: "input-streaming",
          publicData: { ...base, rawInput: (data.rawInput ?? "") + event.delta },
        };
      });
    }
    case EventType.TOOL_CALL_END: {
      return updateTool(state, event.toolCallId, (node) => {
        const data = node.publicData;
        const rawInput = data.rawInput ?? "";
        const parsed = (() => {
          try {
            return JSON.parse(rawInput) as Json;
          } catch {
            return undefined;
          }
        })();
        return {
          ...node,
          state: "input-available",
          publicData: { ...data, ...(parsed !== undefined ? { input: parsed } : {}) },
        };
      });
    }
    case EventType.TOOL_CALL_RESULT: {
      let next = state;
      if (toolNodeIdFor(next, event.toolCallId) === undefined) {
        next = toolNode(next, event.toolCallId, "tool", event.messageId);
      }
      return updateTool(next, event.toolCallId, (node) => {
        const data = node.publicData;
        const output = parseJsonOrString(event.content);
        const disposition = toolDisposition(output);
        return disposition.state === "output-error"
          ? {
              ...node,
              state: "output-error",
              publicData: { ...data, errorText: disposition.errorText },
            }
          : {
              ...node,
              state: "output-available",
              publicData: { ...data, output: disposition.output },
            };
      });
    }
    case EventType.ACTIVITY_SNAPSHOT:
      return activityNode(state, event);
    case EventType.ACTIVITY_DELTA:
      return activityDelta(state, event);
    default:
      return state;
  }
}

function toolDisposition(
  value: Json,
):
  | { readonly state: "output-available"; readonly output: Json }
  | { readonly state: "output-error"; readonly errorText: string } {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value["status"] === "ok" && "output" in value) {
      return { state: "output-available", output: value["output"]! };
    }
    if (value["status"] === "error" && typeof value["errorText"] === "string") {
      return { state: "output-error", errorText: value["errorText"] };
    }
    if (value["status"] === "cancelled") {
      return { state: "output-error", errorText: "Tool execution was cancelled" };
    }
    if (value["status"] === "interrupted" && value["outcome"] === "unknown") {
      return { state: "output-error", errorText: "Tool outcome is unknown after interruption" };
    }
  }
  return { state: "output-available", output: value };
}

function elicitFact(node: PublicElicitActivityNode): ClientElicitFact {
  const data = node.publicData;
  return {
    elicitId: data.elicitId,
    bindingId: data.bindingId,
    toolName: data.toolName,
    key: data.key,
    message: data.message,
    callId: data.callId,
    seq: data.producerSequence,
    ...(data.context !== undefined ? { context: data.context } : {}),
    responseContract: data.responseContract,
    ...(data.contextContract !== undefined ? { contextContract: data.contextContract } : {}),
    placement: {
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      sequence: node.sequence,
    },
  };
}

/** Fold one validated host event and describe the client-local effects it exposes. */
export function transitionChatProjection(
  state: ChatProjectionState,
  event: AGUIEvent,
): ChatProjectionTransition {
  const projection = foldAGUIEvent(state, event);
  const actions: ChatProjectionAction[] = [];

  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    for (const entry of findTextParts(projection)) {
      if (entry.part.state === "done") {
        actions.push({
          type: "text-changed",
          messageId: entry.messageId,
          kind: entry.part.kind,
          delta: entry.part.text,
          done: true,
        });
      }
    }
  } else if (
    event.type === EventType.TEXT_MESSAGE_CONTENT ||
    event.type === EventType.REASONING_MESSAGE_CONTENT
  ) {
    const structuredOutput =
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      state.structuredOutputByMessageId.has(event.messageId);
    if (!structuredOutput) {
      actions.push({
        type: "text-changed",
        messageId: event.messageId,
        kind: event.type === EventType.TEXT_MESSAGE_CONTENT ? "text" : "reasoning",
        delta: event.delta,
        done: false,
      });
    }
  } else if (
    event.type === EventType.TEXT_MESSAGE_END ||
    event.type === EventType.REASONING_MESSAGE_END
  ) {
    const structuredOutput =
      event.type === EventType.TEXT_MESSAGE_END &&
      state.structuredOutputByMessageId.has(event.messageId);
    if (!structuredOutput) {
      actions.push({
        type: "text-changed",
        messageId: event.messageId,
        kind: event.type === EventType.TEXT_MESSAGE_END ? "text" : "reasoning",
        delta: "",
        done: true,
      });
    }
  }

  let elicit: PublicElicitActivityNode | undefined;
  if (
    event.type === EventType.ACTIVITY_SNAPSHOT &&
    event.activityType === "sweatpants:public-execution"
  ) {
    const node = decodePublicActivity(event.content).node;
    if (node.kind === "elicit") {
      elicit = node;
      actions.push({ type: "elicit-observed", request: elicitFact(node) });
    }
  } else if (event.type === EventType.ACTIVITY_DELTA) {
    const node = findElicitNode(projection, event.messageId);
    if (node?.kind === "elicit") {
      elicit = node;
    }
  }
  if (elicit?.state === "responded") {
    actions.push({ type: "elicit-settled", elicitId: elicit.publicData.elicitId });
  } else if (elicit?.state === "cancelled") {
    actions.push({ type: "elicit-cancelled", elicitId: elicit.publicData.elicitId });
  }

  return { projection, actions };
}

export function updateTextPartFrame(
  state: ChatProjectionState,
  messageId: string,
  partId: string,
  frame: Frame,
  rendered: string,
  done?: boolean,
): ChatProjectionState {
  return updateMessage(state, messageId, (message) => ({
    ...message,
    parts: message.parts.map((part) =>
      (part.kind === "text" || part.kind === "reasoning") && part.id === partId
        ? {
            ...part,
            frame,
            rendered,
            ...(done === undefined
              ? {}
              : { state: done ? ("done" as const) : ("streaming" as const) }),
          }
        : part,
    ),
  }));
}

export function markElicitLocalState(
  state: ChatProjectionState,
  _elicitId: string,
  _localState: "running" | "submitting" | "failed" | undefined,
): ChatProjectionState {
  // Local render state is deliberately not represented in generic Chat Core. A
  // frontend adapter overlays it by exact elicitId in its specialized snapshot.
  return state;
}

function nodeChildren(state: ChatProjectionState, nodeId: string): readonly InternalNode[] {
  const children = (state.attachedChildren.get(nodeId) ?? [])
    .map((id) => state.nodes.get(id))
    .filter((node): node is InternalNode => node !== undefined);
  children.sort(
    (left, right) =>
      left.node.sequence - right.node.sequence || left.node.nodeId.localeCompare(right.node.nodeId),
  );
  return children;
}

function materializeToolCallPart<TLocalPart extends { readonly type: string; readonly id: string }>(
  node: PublicToolActivityNode,
  data: Extract<PublicActivityData, { kind: "tool-call" }>,
  children: readonly InternalNode[],
  state: ChatProjectionState,
): ChatUIToolCallPart<TLocalPart> | null {
  const parts = children.flatMap((child) => {
    const value = materializeNode<TLocalPart>(state, child.node.nodeId);
    return value ? [value] : [];
  });
  const base = {
    type: "tool-call" as const,
    id: node.nodeId,
    callId: data.callId,
    name: data.name,
    ...(data.rawInput !== undefined ? { rawInput: data.rawInput } : {}),
    parts,
  };
  switch (node.state) {
    case "input-streaming":
      return { ...base, state: "input-streaming" };
    case "input-available":
      return data.input === undefined
        ? null
        : { ...base, state: "input-available", input: data.input };
    case "output-available":
      return data.input === undefined || data.output === undefined
        ? null
        : { ...base, state: "output-available", input: data.input, output: data.output };
    case "output-error":
      return data.errorText === undefined
        ? null
        : {
            ...base,
            state: "output-error",
            ...(data.input === undefined ? {} : { input: data.input }),
            errorText: data.errorText,
          };
  }
}

function materializeNode<TLocalPart extends { readonly type: string; readonly id: string }>(
  state: ChatProjectionState,
  nodeId: string,
): ChatUIPart<TLocalPart> | null {
  const entry = state.nodes.get(nodeId);
  if (!entry) {
    return null;
  }
  const node = entry.node;
  const data = node.publicData;
  const children = nodeChildren(state, nodeId);
  if (node.kind === "message") {
    if (!data || data.kind !== "message") {
      return null;
    }
    const message = state.messageById.get(data.messageId);
    if (!message) {
      return null;
    }
    const nested: ChatUINestedMessagePart<TLocalPart> = {
      type: "message",
      id: node.nodeId,
      message: materializeMessage<TLocalPart>(state, message),
    };
    return nested;
  }
  if (node.kind === "tool-call") {
    if (!data || data.kind !== "tool-call") {
      return null;
    }
    return materializeToolCallPart(node, data, children, state);
  }
  if (node.kind === "activity") {
    const activity = data?.kind === "activity" ? data : undefined;
    const stateValue =
      node.state === "complete" || node.state === "error" || node.state === "cancelled"
        ? node.state
        : "running";
    const part: ChatUIActivityPart<TLocalPart> = {
      type: "activity",
      id: node.nodeId,
      activityType: activity?.activityType ?? "opaque-execution",
      state: stateValue,
      ...(activity?.data !== undefined ? { data: activity.data } : {}),
      presentation: node.presentation,
      parts: children.flatMap((child) => {
        const value = materializeNode<TLocalPart>(state, child.node.nodeId);
        return value ? [value] : [];
      }),
    };
    return part;
  }
  if (!data || data.kind !== "elicit") {
    return null;
  }
  const elicitState =
    node.state === "responded" ? "responded" : node.state === "cancelled" ? "cancelled" : "pending";
  const part: ChatUIElicitPart<TLocalPart> = {
    type: "elicit",
    id: node.nodeId,
    elicitId: data.elicitId,
    bindingId: data.bindingId,
    key: data.key,
    message: data.message,
    ...(data.context !== undefined ? { context: data.context } : {}),
    state: elicitState,
    parts: children.flatMap((child) => {
      const value = materializeNode<TLocalPart>(state, child.node.nodeId);
      return value ? [value] : [];
    }),
  };
  return part;
}

function materializeStructuredOutputPart(
  part: InternalStructuredOutputPart,
): ChatUIStructuredOutputPart {
  const base = {
    type: "structured-output" as const,
    id: part.id,
    raw: part.raw,
    ...(part.partial !== undefined ? { partial: part.partial } : {}),
  };
  switch (part.status) {
    case "streaming":
      return { ...base, status: "streaming" };
    case "complete":
      return { ...base, status: "complete", data: part.data };
    case "error":
      return { ...base, status: "error", errorText: part.errorText };
  }
}

function materializeMessage<TLocalPart extends { readonly type: string; readonly id: string }>(
  state: ChatProjectionState,
  message: InternalMessage,
): ChatUIMessage<TLocalPart> {
  const messageNodeId = state.messageNodeById.get(message.id);
  const nodeParts = (messageNodeId === undefined ? [] : nodeChildren(state, messageNodeId)).flatMap(
    (child) => {
      const value = materializeNode<TLocalPart>(state, child.node.nodeId);
      return value ? [{ value, sequence: child.node.sequence }] : [];
    },
  );
  const parts = [
    ...message.parts.map((part) => ({
      value:
        part.kind === "structured-output"
          ? materializeStructuredOutputPart(part)
          : part.kind === "media"
            ? ({
                type: part.media,
                id: part.id,
                source: part.source,
                ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
              } as ChatUIMediaPart)
            : part.kind === "text"
              ? ({
                  type: "text" as const,
                  id: part.id,
                  text: part.text,
                  state: part.state,
                  frame: part.frame,
                  rendered: part.rendered,
                } satisfies ChatUITextPart)
              : ({
                  type: "reasoning" as const,
                  id: part.id,
                  text: part.text,
                  state: part.state,
                  frame: part.frame,
                  rendered: part.rendered,
                } satisfies ChatUIReasoningPart),
      sequence: part.sequence,
    })),
    ...nodeParts,
  ];
  parts.sort((left, right) => left.sequence - right.sequence);
  return Object.freeze({
    id: message.id,
    role: message.role,
    parts: Object.freeze(parts.map((part) => part.value)),
    metadata: Object.freeze({}),
  });
}

export function materializeChatMessages<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
>(
  state: ChatProjectionState,
  options: { readonly allowPending?: boolean } = {},
): readonly ChatUIMessage<TLocalPart>[] {
  if (state.pendingChildren.size > 0 && options.allowPending !== true) {
    const parents = [...state.pendingChildren.keys()].join(", ");
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Unresolved public activity parents: ${parents}`,
    );
  }
  const roots = state.messageOrder.flatMap((messageId, order) => {
    const message = state.messageById.get(messageId);
    const nodeId = state.messageNodeById.get(messageId);
    const node = nodeId ? state.nodes.get(nodeId) : undefined;
    return message && node && node.node.parentNodeId === null
      ? [{ message, sequence: node.node.sequence, order }]
      : [];
  });
  roots.sort(
    (left, right) =>
      left.order - right.order ||
      left.sequence - right.sequence ||
      left.message.id.localeCompare(right.message.id),
  );
  const output = roots.map(({ message }) => materializeMessage<TLocalPart>(state, message));
  return Object.freeze(output);
}

export function findElicitNode(
  state: ChatProjectionState,
  elicitIdOrActivityRecordId: string,
): PublicActivityNode | undefined {
  const nodeId =
    state.elicitNodeById.get(elicitIdOrActivityRecordId) ??
    state.activityNodeByRecordId.get(elicitIdOrActivityRecordId);
  return nodeId === undefined ? undefined : state.nodes.get(nodeId)?.node;
}

export function findTextParts(
  state: ChatProjectionState,
): readonly { messageId: string; part: InternalTextPart }[] {
  return [...state.messageById.values()].flatMap((message) =>
    message.parts
      .filter((part): part is InternalTextPart => part.kind === "text" || part.kind === "reasoning")
      .map((part) => ({ messageId: message.id, part })),
  );
}
