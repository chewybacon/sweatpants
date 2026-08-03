import { EventType } from "@ag-ui/core";
import { canonicalJson, type Json } from "@sweatpants/foundation";
import { emptyFrame, type Frame } from "./frame.ts";
import type {
  ActivityDeltaEvent,
  ActivityPart,
  ActivitySnapshotEvent,
  ChatMessage,
  ChatLocalPart,
  ChatPart,
  ChatRequestMessage,
  ChatWireMessage,
  ChatStreamEvent,
  ClientElicitFact,
  ElicitPart,
  NestedMessagePart,
  PublicActivityData,
  PublicActivityNode,
  PublicElicitActivityNode,
  PublicToolActivityNode,
  ReasoningPart,
  TextPart,
  ToolCallPart,
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

interface InternalMessage {
  readonly id: string;
  readonly role: ChatMessage["role"];
  readonly metadata?: Readonly<Record<string, Json>>;
  readonly nodeId: string;
  readonly parts: readonly InternalTextPart[];
}

interface InternalNode {
  readonly node: PublicActivityNode;
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
  readonly nodes: ReadonlyMap<string, InternalNode>;
  readonly messageById: ReadonlyMap<string, InternalMessage>;
  readonly messageNodeById: ReadonlyMap<string, string>;
  readonly toolNodeByCallId: ReadonlyMap<string, string>;
  readonly elicitNodeById: ReadonlyMap<string, string>;
  readonly activityNodeByRecordId: ReadonlyMap<string, string>;
  readonly attachedChildren: ReadonlyMap<string, readonly string[]>;
  readonly pendingChildren: ReadonlyMap<string, readonly string[]>;
  readonly messageOrder: readonly string[];
  readonly nextSequence: number;
  readonly error: Error | null;
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
    nextSequence: 0,
    error: null,
  };
}

function mapCopy<T>(map: ReadonlyMap<string, T>): Map<string, T> {
  return new Map(map);
}

function childrenAdd(
  children: ReadonlyMap<string, readonly string[]>,
  parent: string,
  child: string,
): Map<string, readonly string[]> {
  const output = mapCopy(children);
  const current = output.get(parent) ?? [];
  if (!current.includes(child)) {
    output.set(parent, [...current, child]);
  }
  return output;
}

function childrenRemove(
  children: ReadonlyMap<string, readonly string[]>,
  parent: string,
  child: string,
): Map<string, readonly string[]> {
  const output = mapCopy(children);
  const current = output.get(parent) ?? [];
  const next = current.filter((value) => value !== child);
  if (next.length === 0) {
    output.delete(parent);
  } else {
    output.set(parent, next);
  }
  return output;
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

function attachPending(state: ChatProjectionState, parentId: string): ChatProjectionState {
  const waiting = state.pendingChildren.get(parentId) ?? [];
  if (waiting.length === 0) {
    return state;
  }
  let attachedChildren = state.attachedChildren;
  let pendingChildren = mapCopy(state.pendingChildren);
  pendingChildren.delete(parentId);
  for (const childId of waiting) {
    const child = state.nodes.get(childId);
    if (child) {
      assertSiblingSequence({ ...state, attachedChildren }, child.node, childId);
    }
    attachedChildren = childrenAdd(attachedChildren, parentId, childId);
    if (child) {
      const nested = attachPending({ ...state, attachedChildren, pendingChildren }, childId);
      attachedChildren = nested.attachedChildren;
      pendingChildren = mapCopy(nested.pendingChildren);
    }
  }
  return { ...state, attachedChildren, pendingChildren };
}

function replaceSyntheticMessageNode(
  state: ChatProjectionState,
  messageId: string,
  nodeId: string,
): ChatProjectionState {
  const oldNodeId = state.messageNodeById.get(messageId);
  if (!oldNodeId || oldNodeId === nodeId || !state.nodes.has(oldNodeId)) {
    return { ...state, messageNodeById: new Map(state.messageNodeById).set(messageId, nodeId) };
  }
  const oldNode = state.nodes.get(oldNodeId)!;
  const synthetic =
    oldNode.node.publicData?.kind === "message" &&
    oldNode.node.publicData.messageId === messageId &&
    oldNodeId === `message:${messageId}`;
  if (!synthetic) {
    return { ...state, messageNodeById: new Map(state.messageNodeById).set(messageId, nodeId) };
  }
  const nodes = mapCopy(state.nodes);
  nodes.delete(oldNodeId);

  // Standard AG-UI message/tool events can establish content before the
  // producer's placement activity arrives. Only those synthetic descendants
  // may move with the message; producer-placed children remain immutable.
  const provisionalChildren = state.attachedChildren.get(oldNodeId) ?? [];
  for (const childId of provisionalChildren) {
    const child = nodes.get(childId);
    if (!child) {
      continue;
    }
    if (!child.synthetic) {
      throw new ChatProjectionError(
        "chat_activity_conflict",
        `Authoritative child "${childId}" cannot move with provisional message "${messageId}"`,
      );
    }
    nodes.set(childId, {
      ...child,
      node: { ...child.node, parentNodeId: nodeId },
    });
  }

  const attachedChildren = childrenRemove(
    state.attachedChildren,
    oldNode.node.parentNodeId ?? "",
    oldNodeId,
  );
  attachedChildren.delete(oldNodeId);
  if (provisionalChildren.length > 0) {
    attachedChildren.set(nodeId, provisionalChildren);
  }

  const pendingChildren = mapCopy(state.pendingChildren);
  const waitingForProvisional = pendingChildren.get(oldNodeId);
  pendingChildren.delete(oldNodeId);
  if (waitingForProvisional && waitingForProvisional.length > 0) {
    pendingChildren.set(nodeId, waitingForProvisional);
  }
  for (const [parent, children] of pendingChildren) {
    const next = children.filter((child) => child !== oldNodeId);
    if (next.length === 0) {
      pendingChildren.delete(parent);
    } else {
      pendingChildren.set(parent, next);
    }
  }

  const messageById = mapCopy(state.messageById);
  const message = messageById.get(messageId);
  if (message) {
    messageById.set(messageId, { ...message, nodeId });
  }
  return {
    ...state,
    nodes,
    messageById,
    attachedChildren,
    pendingChildren,
    messageNodeById: new Map(state.messageNodeById).set(messageId, nodeId),
  };
}

function assertSiblingSequence(
  state: ChatProjectionState,
  node: PublicActivityNode,
  excludingNodeId?: string,
): void {
  const siblings =
    node.parentNodeId === null
      ? [...state.nodes.values()]
          .filter((entry) => entry.node.parentNodeId === null)
          .map((entry) => entry.node)
      : (state.attachedChildren.get(node.parentNodeId) ?? [])
          .map((siblingId) => state.nodes.get(siblingId)?.node)
          .filter((sibling): sibling is PublicActivityNode => sibling !== undefined);
  for (const sibling of siblings) {
    if (sibling.nodeId === excludingNodeId) {
      continue;
    }
    if (sibling.sequence === node.sequence) {
      throw new ChatProjectionError(
        "chat_activity_conflict",
        `Sibling sequence ${node.sequence} is already occupied under parent "${node.parentNodeId}"`,
      );
    }
  }
}

function addGraphNode(
  state: ChatProjectionState,
  node: PublicActivityNode,
  activityRecordId: string,
  synthetic = false,
): ChatProjectionState {
  const existingRecord = state.activityNodeByRecordId.get(activityRecordId);
  if (existingRecord !== undefined && existingRecord !== node.nodeId) {
    throw new ChatProjectionError(
      "chat_activity_conflict",
      `Activity record "${activityRecordId}" changed node identity`,
    );
  }
  const existing = state.nodes.get(node.nodeId);
  if (existing) {
    if (nodeImmutable(existing.node) !== nodeImmutable(node) && !existing.synthetic) {
      throw new ChatProjectionError(
        "chat_activity_conflict",
        `Node "${node.nodeId}" was reused with conflicting immutable facts`,
      );
    }
    const nodes = mapCopy(state.nodes);
    nodes.set(node.nodeId, {
      ...existing,
      node: existing.synthetic && !synthetic ? node : cloneNodeWithMutable(existing.node, node),
      synthetic: existing.synthetic && synthetic,
    });
    return {
      ...state,
      nodes,
      activityNodeByRecordId: new Map(state.activityNodeByRecordId).set(
        activityRecordId,
        node.nodeId,
      ),
    };
  }
  if (node.parentNodeId !== null && state.nodes.has(node.parentNodeId)) {
    assertSiblingSequence(state, node, node.nodeId);
  }
  if (node.parentNodeId !== null && !state.nodes.has(node.parentNodeId)) {
    const nodes = mapCopy(state.nodes);
    nodes.set(node.nodeId, { node, activityRecordId, synthetic });
    const pendingChildren = childrenAdd(state.pendingChildren, node.parentNodeId, node.nodeId);
    return {
      ...state,
      nodes,
      pendingChildren,
      activityNodeByRecordId: new Map(state.activityNodeByRecordId).set(
        activityRecordId,
        node.nodeId,
      ),
      nextSequence: Math.max(state.nextSequence, node.sequence + 1),
    };
  }
  const nodes = mapCopy(state.nodes);
  nodes.set(node.nodeId, { node, activityRecordId, synthetic });
  let next: ChatProjectionState = {
    ...state,
    nodes,
    attachedChildren:
      node.parentNodeId === null
        ? state.attachedChildren
        : childrenAdd(state.attachedChildren, node.parentNodeId, node.nodeId),
    activityNodeByRecordId: new Map(state.activityNodeByRecordId).set(
      activityRecordId,
      node.nodeId,
    ),
    nextSequence: Math.max(state.nextSequence, node.sequence + 1),
  };
  next = attachPending(next, node.nodeId);
  return next;
}

function ensureMessage(
  state: ChatProjectionState,
  messageId: string,
  role: ChatMessage["role"],
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
  const nodeId = state.messageNodeById.get(messageId) ?? `message:${messageId}`;
  const node: PublicActivityNode = {
    nodeId,
    parentNodeId: null,
    sequence: state.nextSequence,
    kind: "message",
    state: "streaming",
    presentation: "public",
    publicData: { kind: "message", messageId, role },
  };
  let next = nodeId === `message:${messageId}` ? addGraphNode(state, node, nodeId, true) : state;
  const messageById = mapCopy(next.messageById);
  messageById.set(messageId, { id: messageId, role, nodeId, parts: [] });
  const messageNodeById = mapCopy(next.messageNodeById);
  messageNodeById.set(messageId, nodeId);
  const messageOrder = next.messageOrder.includes(messageId)
    ? next.messageOrder
    : [...next.messageOrder, messageId];
  next = {
    ...next,
    messageById,
    messageNodeById,
    messageOrder,
    nextSequence: next.nextSequence + 1,
  };
  return next;
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
  let next = replaceSyntheticMessageNode(state, messageId, node.nodeId);
  next = addGraphNode(next, node, node.nodeId, false);
  if (!existing) {
    const messageById = mapCopy(next.messageById);
    messageById.set(messageId, {
      id: messageId,
      role: node.publicData.role,
      nodeId: node.nodeId,
      parts: [],
    });
    const messageNodeById = mapCopy(next.messageNodeById);
    messageNodeById.set(messageId, node.nodeId);
    const messageOrder =
      node.parentNodeId === null && !next.messageOrder.includes(messageId)
        ? [...next.messageOrder, messageId]
        : next.messageOrder;
    next = { ...next, messageById, messageNodeById, messageOrder };
  }
  return next;
}

function latestMessageId(
  state: ChatProjectionState,
  role?: ChatMessage["role"],
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
  if (index < 0 || parts[index]!.state === "done") {
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
  if (!last || last.kind !== kind || last.state === "done") {
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

function toolNode(
  state: ChatProjectionState,
  callId: string,
  name: string,
  parentMessageId?: string,
): ChatProjectionState {
  const existingNodeId = state.toolNodeByCallId.get(callId);
  if (existingNodeId) {
    return state;
  }
  const messageId = parentMessageId ?? latestMessageId(state, "assistant");
  if (!messageId) {
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Tool call "${callId}" has no parent message`,
    );
  }
  let next = ensureMessage(state, messageId, "assistant");
  const parentNodeId = next.messageNodeById.get(messageId)!;
  const nodeId = `execution:${callId}`;
  const node: PublicActivityNode = {
    nodeId,
    parentNodeId,
    sequence: next.nextSequence,
    kind: "tool-call",
    state: "input-streaming",
    presentation: "public",
    publicData: { kind: "tool-call", callId, name, rawInput: "" },
  };
  next = addGraphNode(next, node, nodeId, true);
  const toolNodeByCallId = mapCopy(next.toolNodeByCallId);
  toolNodeByCallId.set(callId, nodeId);
  return { ...next, toolNodeByCallId, nextSequence: next.nextSequence + 1 };
}

function updateTool(
  state: ChatProjectionState,
  callId: string,
  update: (node: PublicToolActivityNode) => PublicToolActivityNode,
): ChatProjectionState {
  const nodeId = state.toolNodeByCallId.get(callId);
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
    const parentNodeId =
      parentMessageId === undefined ? null : (next.messageNodeById.get(parentMessageId) ?? null);
    if (parentMessageId !== undefined && parentNodeId === null) {
      next = ensureMessage(next, parentMessageId, "assistant");
    }
    const nodeId = `activity:${event.messageId}`;
    const node: PublicActivityNode = {
      nodeId,
      parentNodeId:
        parentMessageId === undefined ? null : (next.messageNodeById.get(parentMessageId) ?? null),
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
    return addGraphNode(next, node, event.messageId);
  }
  const activity = decodePublicActivity(event.content);
  let next = ensureMessageFromActivity(state, activity.node);
  next = addGraphNode(next, activity.node, event.messageId);
  const data = activity.node.publicData;
  if (data?.kind === "message") {
    next = replaceSyntheticMessageNode(next, data.messageId, activity.node.nodeId);
  } else if (data?.kind === "tool-call") {
    const toolNodeByCallId = mapCopy(next.toolNodeByCallId);
    toolNodeByCallId.set(data.callId, activity.node.nodeId);
    next = { ...next, toolNodeByCallId };
  } else if (data?.kind === "elicit") {
    const elicitNodeById = mapCopy(next.elicitNodeById);
    elicitNodeById.set(data.elicitId, activity.node.nodeId);
    next = { ...next, elicitNodeById };
  }
  return next;
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

function chatRole(role: ChatWireMessage["role"]): ChatMessage["role"] | undefined {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  if (role === "developer") {
    return "system";
  }
  return undefined;
}

function messageToWire<TLocalPart extends ChatLocalPart>(
  message: ChatMessage<TLocalPart>,
): ChatRequestMessage {
  const text = message.parts
    .filter((part): part is TextPart => part.type === "text" && "text" in part)
    .map((part) => part.text)
    .join("");
  const toolCalls = message.parts
    .filter(
      (part): part is ToolCallPart<TLocalPart> => part.type === "tool-call" && "callId" in part,
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
    return { id: message.id, role: message.role, content: text };
  }
  return {
    id: message.id,
    role: "assistant",
    ...(text.length > 0 ? { content: text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Project public root messages back to provider-facing AG-UI history. */
export function projectChatMessagesToWire<TLocalPart extends ChatLocalPart>(
  messages: readonly ChatMessage<TLocalPart>[],
): readonly ChatRequestMessage[] {
  return messages.flatMap((message) => {
    const wire = messageToWire(message);
    if (message.role !== "assistant") {
      return [wire];
    }
    const results: ChatRequestMessage[] = message.parts.flatMap((part): ChatRequestMessage[] => {
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
    });
    return [wire, ...results];
  });
}

export function appendChatWireMessage(
  state: ChatProjectionState,
  message: ChatWireMessage,
): ChatProjectionState {
  if (message.role === "tool") {
    const nodeId = state.toolNodeByCallId.get(message.toolCallId);
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
  const content = wireContent(message.content);
  const existing = next.messageById.get(message.id);
  const alreadyHasContent =
    content !== undefined &&
    existing?.parts.some((part) => part.kind === "text" && part.text === content) === true;
  if (content !== undefined && content.length > 0 && !alreadyHasContent) {
    next = startContent(next, message.id, "text");
    next = contentPart(next, message.id, "text", content);
    next = endContent(next, message.id, "text");
  }
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

export function foldChatStreamEvent(
  state: ChatProjectionState,
  event: ChatStreamEvent,
): ChatProjectionState {
  switch (event.type) {
    case EventType.MESSAGES_SNAPSHOT: {
      let next = state;
      for (const message of event.messages) {
        next = appendChatWireMessage(next, message);
      }
      return next;
    }
    case EventType.TEXT_MESSAGE_START: {
      const role = chatRole(event.role);
      return role === undefined
        ? state
        : startContent(ensureMessage(state, event.messageId, role), event.messageId, "text");
    }
    case EventType.TEXT_MESSAGE_CONTENT:
      return contentPart(state, event.messageId, "text", event.delta);
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
      if (!next.toolNodeByCallId.has(event.toolCallId)) {
        next = toolNode(next, event.toolCallId, "tool", event.messageId);
      }
      return updateTool(next, event.toolCallId, (node) => {
        const data = node.publicData;
        const output = parseJsonOrString(event.content);
        return { ...node, state: "output-available", publicData: { ...data, output } };
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
  event: ChatStreamEvent,
): ChatProjectionTransition {
  const projection = foldChatStreamEvent(state, event);
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
    actions.push({
      type: "text-changed",
      messageId: event.messageId,
      kind: event.type === EventType.TEXT_MESSAGE_CONTENT ? "text" : "reasoning",
      delta: event.delta,
      done: false,
    });
  } else if (
    event.type === EventType.TEXT_MESSAGE_END ||
    event.type === EventType.REASONING_MESSAGE_END
  ) {
    actions.push({
      type: "text-changed",
      messageId: event.messageId,
      kind: event.type === EventType.TEXT_MESSAGE_END ? "text" : "reasoning",
      delta: "",
      done: true,
    });
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
      part.id === partId
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

function materializeNode<TLocalPart extends { readonly type: string; readonly id: string }>(
  state: ChatProjectionState,
  nodeId: string,
): ChatPart<TLocalPart> | null {
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
    const nested: NestedMessagePart<TLocalPart> = {
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
    const part: ToolCallPart<TLocalPart> = {
      type: "tool-call",
      id: node.nodeId,
      callId: data.callId,
      name: data.name,
      state:
        node.state === "output-error"
          ? "output-error"
          : node.state === "output-available"
            ? "output-available"
            : node.state === "input-available"
              ? "input-available"
              : "input-streaming",
      ...(data.rawInput !== undefined ? { rawInput: data.rawInput } : {}),
      ...(data.input !== undefined ? { input: data.input } : {}),
      ...(data.output !== undefined ? { output: data.output } : {}),
      ...(data.errorText !== undefined ? { errorText: data.errorText } : {}),
      parts: children.flatMap((child) => {
        const value = materializeNode<TLocalPart>(state, child.node.nodeId);
        return value ? [value] : [];
      }),
    };
    return part;
  }
  if (node.kind === "activity") {
    const activity = data?.kind === "activity" ? data : undefined;
    const stateValue =
      node.state === "complete" || node.state === "error" || node.state === "cancelled"
        ? node.state
        : "running";
    const part: ActivityPart<TLocalPart> = {
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
  const part: ElicitPart<TLocalPart> = {
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

function materializeMessage<TLocalPart extends { readonly type: string; readonly id: string }>(
  state: ChatProjectionState,
  message: InternalMessage,
): ChatMessage<TLocalPart> {
  const nodeParts = nodeChildren(state, message.nodeId).flatMap((child) => {
    const value = materializeNode<TLocalPart>(state, child.node.nodeId);
    return value ? [{ value, sequence: child.node.sequence }] : [];
  });
  const parts = [
    ...message.parts.map((part) => ({
      value:
        part.kind === "text"
          ? ({
              type: "text" as const,
              id: part.id,
              text: part.text,
              state: part.state,
              frame: part.frame,
              rendered: part.rendered,
            } satisfies TextPart)
          : ({
              type: "reasoning" as const,
              id: part.id,
              text: part.text,
              state: part.state,
              frame: part.frame,
              rendered: part.rendered,
            } satisfies ReasoningPart),
      sequence: part.sequence,
    })),
    ...nodeParts,
  ];
  parts.sort((left, right) => left.sequence - right.sequence);
  return Object.freeze({
    id: message.id,
    role: message.role,
    parts: Object.freeze(parts.map((part) => part.value)),
  });
}

export function materializeChatMessages<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
>(
  state: ChatProjectionState,
  options: { readonly allowPending?: boolean } = {},
): readonly ChatMessage<TLocalPart>[] {
  if (state.pendingChildren.size > 0 && options.allowPending !== true) {
    const parents = [...state.pendingChildren.keys()].join(", ");
    throw new ChatProjectionError(
      "chat_activity_parent_missing",
      `Unresolved public activity parents: ${parents}`,
    );
  }
  const roots = state.messageOrder.flatMap((messageId) => {
    const message = state.messageById.get(messageId);
    const nodeId = state.messageNodeById.get(messageId);
    const node = nodeId ? state.nodes.get(nodeId) : undefined;
    return message && node && node.node.parentNodeId === null
      ? [{ message, sequence: node.node.sequence }]
      : [];
  });
  roots.sort(
    (left, right) =>
      left.sequence - right.sequence || left.message.id.localeCompare(right.message.id),
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
    message.parts.map((part) => ({ messageId: message.id, part })),
  );
}
