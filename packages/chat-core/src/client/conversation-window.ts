import { EventType, type ActivitySnapshotEvent, type Message } from "@ag-ui/core";
import { assertJson, type Json } from "@sweatpants/foundation";
import { decodeActivitySnapshotEvent, decodeAGUIEvent } from "./chat-client-codec.ts";
import type { PublicActivityData } from "./public-activity.ts";

export const CONVERSATION_WINDOW_FRAME_TYPE = "sweatpants.conversation-window.v1" as const;
export const MAX_DURABLE_POSITION = 18_446_744_073_709_551_615n;
export const MAX_WINDOW_HOT_ROOTS = 256;
export const MAX_PROJECTION_TOKEN_BYTES = 64 * 1024;

export type DurablePosition = string;
export type ArchiveOrdinal = string;
export type PublicHistoryCursor = string;
export type WindowBasisToken = string;

export class ConversationWindowError extends Error {
  readonly code = "conversation_window_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationWindowError";
  }
}

export interface PublicArtifactReference {
  readonly uri: string;
  readonly mediaType?: string;
  readonly digest?: string;
}

export interface PublicAttribution {
  readonly participantId?: string;
  readonly displayName?: string;
  readonly avatar?: PublicArtifactReference;
}

export interface PublicPlacementAnchor {
  /** Original message-root position; absent only in legacy stored anchors. */
  readonly messagePosition?: DurablePosition;
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
  readonly kind: "message" | "activity" | "tool-call" | "elicit";
  readonly presentation: "public" | "opaque";
  readonly publicData: PublicActivityData;
}

export type PublicMessagePlacement =
  | { readonly type: "root"; readonly sequence: number }
  | {
      readonly type: "activity-message";
      readonly nodeId: string;
      readonly parentNodeId: string;
      readonly sequence: number;
      readonly anchors: readonly PublicPlacementAnchor[];
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly anchors: readonly PublicPlacementAnchor[];
    };

interface PublicProjectionRootBase {
  readonly rootId: string;
  readonly position: DurablePosition;
  readonly state: "mutable" | "sealed";
  readonly attribution: PublicAttribution;
  readonly logicalTurnId?: string;
  readonly executionId?: string;
}

export interface PublicMessageRoot extends PublicProjectionRootBase {
  readonly kind: "message";
  readonly message: Message;
  readonly placement: PublicMessagePlacement;
}

export interface PublicActivityNodeSnapshot {
  readonly activityRecordId: string;
  readonly producerSequence: number;
  readonly event: ActivitySnapshotEvent;
}

export interface PublicActivitySubtreeRoot extends PublicProjectionRootBase {
  readonly kind: "activity-subtree";
  readonly rootNodeId: string;
  readonly producerSequence: number;
  readonly anchors: readonly PublicPlacementAnchor[];
  readonly nodes: readonly PublicActivityNodeSnapshot[];
  readonly unloadedDescendantCount: number;
}

export type PublicProjectionRoot = PublicMessageRoot | PublicActivitySubtreeRoot;

export interface PublicProjectionBasis {
  readonly lineageId: string;
  readonly basisRevision: string;
  readonly archiveFrontierOrdinal: ArchiveOrdinal;
  readonly nextPublicPosition: DurablePosition;
  readonly hotRootPositions: readonly DurablePosition[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface PublicHistoryCursorPayload extends PublicProjectionBasis {
  readonly beforePosition: DurablePosition;
}

export interface ConversationWindowFrame {
  readonly type: typeof CONVERSATION_WINDOW_FRAME_TYPE;
  readonly conversationId: string;
  readonly lineageId: string;
  readonly basisRevision: string;
  readonly windowToken: WindowBasisToken;
  readonly windowMode: "reset" | "continue";
  readonly archiveFrontierOrdinal: ArchiveOrdinal;
  readonly nextPublicPosition: DurablePosition;
  readonly hotRoots: readonly PublicProjectionRoot[];
  readonly sealedCatchupRoots: readonly PublicProjectionRoot[];
  readonly applicationState: Json;
  readonly olderHistoryCursor: PublicHistoryCursor | null;
}

export interface PublicHistoryPage {
  readonly roots: readonly PublicProjectionRoot[];
  readonly nextOlderCursor: PublicHistoryCursor | null;
}

function invalid(message: string): never {
  throw new ConversationWindowError(message);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${path} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) {
      invalid(`${path}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key} is not allowed`);
    }
  }
}

function identity(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    return invalid(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function optionalIdentity(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : identity(value, path);
}

export function decodeDurablePosition(value: unknown, path: string): DurablePosition {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return invalid(`${path} must be a canonical non-negative decimal string`);
  }
  if (BigInt(value) > MAX_DURABLE_POSITION) {
    return invalid(`${path} exceeds the durable 64-bit range`);
  }
  return value;
}

function natural(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function token(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${path} must be a non-empty string`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_PROJECTION_TOKEN_BYTES * 2) {
    return invalid(`${path} is too large`);
  }
  return value;
}

function json(value: unknown, path: string): Json {
  try {
    return assertJson(value, path);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : `${path} must be JSON`);
  }
}

function decodeArtifact(value: unknown, path: string): PublicArtifactReference {
  const input = record(value, path);
  exactKeys(input, ["uri"], ["mediaType", "digest"], path);
  return {
    uri: identity(input["uri"], `${path}.uri`),
    /* CONDITIONAL-SPREAD: Omit absent mediaType from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["mediaType"] === undefined
      ? {}
      : { mediaType: identity(input["mediaType"], `${path}.mediaType`) }),
    /* CONDITIONAL-SPREAD: Omit absent digest from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["digest"] === undefined
      ? {}
      : { digest: identity(input["digest"], `${path}.digest`) }),
  };
}

function decodeAttribution(value: unknown, path: string): PublicAttribution {
  const input = record(value, path);
  exactKeys(input, [], ["participantId", "displayName", "avatar"], path);
  return {
    /* CONDITIONAL-SPREAD: Omit absent participantId from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["participantId"] === undefined
      ? {}
      : { participantId: identity(input["participantId"], `${path}.participantId`) }),
    /* CONDITIONAL-SPREAD: Omit absent displayName from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["displayName"] === undefined
      ? {}
      : { displayName: identity(input["displayName"], `${path}.displayName`) }),
    /* CONDITIONAL-SPREAD: Omit absent avatar from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["avatar"] === undefined
      ? {}
      : { avatar: decodeArtifact(input["avatar"], `${path}.avatar`) }),
  };
}

function decodePublicData(value: unknown, path: string): PublicActivityData {
  const input = record(value, path);
  const kind = input["kind"];
  const base = {
    version: 1 as const,
    node: {
      nodeId: "anchor-validation",
      parentNodeId: null,
      sequence: 0,
      kind,
      state:
        kind === "message"
          ? "done"
          : kind === "tool-call"
            ? "input-streaming"
            : kind === "elicit"
              ? "pending"
              : "running",
      presentation: "public",
      publicData: value,
    },
  };
  // Reuse the strict activity semantic decoder. Tool anchors can describe a
  // later state, so choose the lifecycle state from the fields that are present.
  if (kind === "tool-call") {
    const tool = input;
    (base.node as Record<string, unknown>)["state"] =
      tool["errorText"] !== undefined
        ? "output-error"
        : tool["output"] !== undefined
          ? "output-available"
          : tool["input"] !== undefined
            ? "input-available"
            : "input-streaming";
  }
  const event = decodeActivitySnapshotEvent({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: "anchor-validation",
    activityType: "sweatpants:public-execution",
    content: base,
    replace: true,
  });
  const content = event.content as unknown as { node: { publicData?: PublicActivityData } };
  if (content.node.publicData === undefined) {
    return invalid(`${path} must contain public activity data`);
  }
  return content.node.publicData;
}

function decodeAnchor(value: unknown, path: string): PublicPlacementAnchor {
  const input = record(value, path);
  exactKeys(
    input,
    ["nodeId", "parentNodeId", "sequence", "kind", "presentation", "publicData"],
    ["messagePosition"],
    path,
  );
  const parent = input["parentNodeId"];
  const kind = input["kind"];
  if (!(kind === "message" || kind === "activity" || kind === "tool-call" || kind === "elicit")) {
    return invalid(`${path}.kind is invalid`);
  }
  const presentation = input["presentation"];
  if (!(presentation === "public" || presentation === "opaque")) {
    return invalid(`${path}.presentation is invalid`);
  }
  const publicData = decodePublicData(input["publicData"], `${path}.publicData`);
  if (publicData.kind !== kind) {
    return invalid(`${path}.publicData.kind does not match anchor kind`);
  }
  return {
    /* CONDITIONAL-SPREAD: Omit absent messagePosition from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(input["messagePosition"] === undefined
      ? {}
      : {
          messagePosition: decodeDurablePosition(
            input["messagePosition"],
            `${path}.messagePosition`,
          ),
        }),
    nodeId: identity(input["nodeId"], `${path}.nodeId`),
    parentNodeId: parent === null ? null : identity(parent, `${path}.parentNodeId`),
    sequence: natural(input["sequence"], `${path}.sequence`),
    kind,
    presentation,
    publicData,
  };
}

function decodeAnchors(value: unknown, path: string): readonly PublicPlacementAnchor[] {
  if (!Array.isArray(value) || value.length > 256) {
    return invalid(`${path} must be an array of at most 256 anchors`);
  }
  const result = value.map((entry, index) => decodeAnchor(entry, `${path}[${index}]`));
  const seen = new Map<string, string>();
  for (const anchor of result) {
    const canonical = JSON.stringify(anchor);
    const previous = seen.get(anchor.nodeId);
    if (previous !== undefined && previous !== canonical) {
      invalid(`${path} contains conflicting anchor ${anchor.nodeId}`);
    }
    seen.set(anchor.nodeId, canonical);
  }
  return result;
}

function decodePlacement(value: unknown, path: string): PublicMessagePlacement {
  const input = record(value, path);
  const type = input["type"];
  if (type === "root") {
    exactKeys(input, ["type", "sequence"], [], path);
    return { type, sequence: natural(input["sequence"], `${path}.sequence`) };
  }
  if (type === "activity-message") {
    exactKeys(input, ["type", "nodeId", "parentNodeId", "sequence", "anchors"], [], path);
    return {
      type,
      nodeId: identity(input["nodeId"], `${path}.nodeId`),
      parentNodeId: identity(input["parentNodeId"], `${path}.parentNodeId`),
      sequence: natural(input["sequence"], `${path}.sequence`),
      anchors: decodeAnchors(input["anchors"], `${path}.anchors`),
    };
  }
  if (type === "tool-result") {
    exactKeys(input, ["type", "toolCallId", "anchors"], [], path);
    return {
      type,
      toolCallId: identity(input["toolCallId"], `${path}.toolCallId`),
      anchors: decodeAnchors(input["anchors"], `${path}.anchors`),
    };
  }
  return invalid(`${path}.type is invalid`);
}

function decodeMessage(value: unknown, path: string): Message {
  const snapshot = decodeAGUIEvent({ type: EventType.MESSAGES_SNAPSHOT, messages: [value] });
  if (snapshot.type !== EventType.MESSAGES_SNAPSHOT || snapshot.messages.length !== 1) {
    return invalid(`${path} must be one complete AG-UI message`);
  }
  return snapshot.messages[0]!;
}

function decodeNodeSnapshot(value: unknown, path: string): PublicActivityNodeSnapshot {
  const input = record(value, path);
  exactKeys(input, ["activityRecordId", "producerSequence", "event"], [], path);
  return {
    activityRecordId: identity(input["activityRecordId"], `${path}.activityRecordId`),
    producerSequence: natural(input["producerSequence"], `${path}.producerSequence`),
    event: decodeActivitySnapshotEvent(input["event"]),
  };
}

export function decodePublicProjectionRoot(value: unknown, path = "$.root"): PublicProjectionRoot {
  const input = record(value, path);
  const commonRequired = ["rootId", "position", "kind", "state", "attribution"];
  const commonOptional = ["logicalTurnId", "executionId"];
  const rawState = input["state"];
  if (!(rawState === "mutable" || rawState === "sealed")) {
    return invalid(`${path}.state is invalid`);
  }
  const state: "mutable" | "sealed" = rawState;
  const logicalTurnId = optionalIdentity(input["logicalTurnId"], `${path}.logicalTurnId`);
  const executionId = optionalIdentity(input["executionId"], `${path}.executionId`);
  const common = {
    rootId: identity(input["rootId"], `${path}.rootId`),
    position: decodeDurablePosition(input["position"], `${path}.position`),
    state,
    attribution: decodeAttribution(input["attribution"], `${path}.attribution`),
    /* CONDITIONAL-SPREAD: Omit absent logicalTurnId from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(logicalTurnId === undefined ? {} : { logicalTurnId }),
    /* CONDITIONAL-SPREAD: Omit absent executionId from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(executionId === undefined ? {} : { executionId }),
  };
  if (input["kind"] === "message") {
    exactKeys(input, [...commonRequired, "message", "placement"], commonOptional, path);
    return {
      ...common,
      kind: "message",
      message: decodeMessage(input["message"], `${path}.message`),
      placement: decodePlacement(input["placement"], `${path}.placement`),
    };
  }
  if (input["kind"] === "activity-subtree") {
    exactKeys(
      input,
      [
        ...commonRequired,
        "rootNodeId",
        "producerSequence",
        "anchors",
        "nodes",
        "unloadedDescendantCount",
      ],
      commonOptional,
      path,
    );
    if (!Array.isArray(input["nodes"]) || input["nodes"].length > 256) {
      return invalid(`${path}.nodes must be an array of at most 256 snapshots`);
    }
    const nodes = input["nodes"].map((entry, index) =>
      decodeNodeSnapshot(entry, `${path}.nodes[${index}]`),
    );
    const nodeIds = new Set<string>();
    for (const node of nodes) {
      const content = node.event.content as unknown as { node?: { nodeId?: unknown } };
      const nodeId = content.node?.nodeId;
      if (typeof nodeId !== "string" || nodeIds.has(nodeId)) {
        return invalid(`${path}.nodes must contain one latest snapshot per node`);
      }
      nodeIds.add(nodeId);
    }
    return {
      ...common,
      kind: "activity-subtree",
      rootNodeId: identity(input["rootNodeId"], `${path}.rootNodeId`),
      producerSequence: natural(input["producerSequence"], `${path}.producerSequence`),
      anchors: decodeAnchors(input["anchors"], `${path}.anchors`),
      nodes,
      unloadedDescendantCount: natural(
        input["unloadedDescendantCount"],
        `${path}.unloadedDescendantCount`,
      ),
    };
  }
  return invalid(`${path}.kind is invalid`);
}

export function decodePublicProjectionRoots(
  value: unknown,
  path = "$.roots",
): readonly PublicProjectionRoot[] {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array`);
  }
  const roots = value.map((entry, index) => decodePublicProjectionRoot(entry, `${path}[${index}]`));
  const byId = new Map<string, PublicProjectionRoot>();
  const byPosition = new Map<string, PublicProjectionRoot>();
  for (const root of roots) {
    const id = byId.get(root.rootId);
    const position = byPosition.get(root.position);
    if (
      (id && JSON.stringify(id) !== JSON.stringify(root)) ||
      (position && position.rootId !== root.rootId)
    ) {
      return invalid(`${path} contains a root identity or position conflict`);
    }
    byId.set(root.rootId, root);
    byPosition.set(root.position, root);
  }
  return roots;
}

export function decodePublicProjectionBasis(
  value: unknown,
  path = "$.basis",
): PublicProjectionBasis {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "lineageId",
      "basisRevision",
      "archiveFrontierOrdinal",
      "nextPublicPosition",
      "hotRootPositions",
      "issuedAt",
      "expiresAt",
    ],
    [],
    path,
  );
  if (
    !Array.isArray(input["hotRootPositions"]) ||
    input["hotRootPositions"].length > MAX_WINDOW_HOT_ROOTS
  ) {
    return invalid(`${path}.hotRootPositions must contain at most 256 positions`);
  }
  const hotRootPositions = input["hotRootPositions"].map((entry, index) =>
    decodeDurablePosition(entry, `${path}.hotRootPositions[${index}]`),
  );
  for (let index = 1; index < hotRootPositions.length; index += 1) {
    if (BigInt(hotRootPositions[index - 1]!) >= BigInt(hotRootPositions[index]!)) {
      return invalid(`${path}.hotRootPositions must be unique and numerically sorted`);
    }
  }
  const issuedAt = natural(input["issuedAt"], `${path}.issuedAt`);
  const expiresAt = natural(input["expiresAt"], `${path}.expiresAt`);
  if (expiresAt <= issuedAt) {
    return invalid(`${path}.expiresAt must be greater than issuedAt`);
  }
  const nextPublicPosition = decodeDurablePosition(
    input["nextPublicPosition"],
    `${path}.nextPublicPosition`,
  );
  if (hotRootPositions.some((position) => BigInt(position) >= BigInt(nextPublicPosition))) {
    return invalid(`${path}.hotRootPositions must be below nextPublicPosition`);
  }
  return {
    lineageId: identity(input["lineageId"], `${path}.lineageId`),
    basisRevision: decodeDurablePosition(input["basisRevision"], `${path}.basisRevision`),
    archiveFrontierOrdinal: decodeDurablePosition(
      input["archiveFrontierOrdinal"],
      `${path}.archiveFrontierOrdinal`,
    ),
    nextPublicPosition,
    hotRootPositions,
    issuedAt,
    expiresAt,
  };
}

export function decodePublicHistoryCursorPayload(
  value: unknown,
  path = "$.cursor",
): PublicHistoryCursorPayload {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "lineageId",
      "basisRevision",
      "archiveFrontierOrdinal",
      "nextPublicPosition",
      "hotRootPositions",
      "issuedAt",
      "expiresAt",
      "beforePosition",
    ],
    [],
    path,
  );
  const basis = decodePublicProjectionBasis(
    Object.fromEntries(Object.entries(input).filter(([key]) => key !== "beforePosition")),
    path,
  );
  const beforePosition = decodeDurablePosition(input["beforePosition"], `${path}.beforePosition`);
  if (BigInt(beforePosition) > BigInt(basis.nextPublicPosition)) {
    return invalid(`${path}.beforePosition exceeds nextPublicPosition`);
  }
  return { ...basis, beforePosition };
}

export function decodeConversationWindow(value: unknown): ConversationWindowFrame {
  const input = record(value, "window");
  exactKeys(
    input,
    [
      "type",
      "conversationId",
      "lineageId",
      "basisRevision",
      "windowToken",
      "windowMode",
      "archiveFrontierOrdinal",
      "nextPublicPosition",
      "hotRoots",
      "sealedCatchupRoots",
      "applicationState",
      "olderHistoryCursor",
    ],
    [],
    "window",
  );
  if (input["type"] !== CONVERSATION_WINDOW_FRAME_TYPE) {
    return invalid("window.type is invalid");
  }
  const windowMode = input["windowMode"];
  if (!(windowMode === "reset" || windowMode === "continue")) {
    return invalid("window.windowMode is invalid");
  }
  const hotRoots = decodePublicProjectionRoots(input["hotRoots"], "window.hotRoots");
  if (hotRoots.length > MAX_WINDOW_HOT_ROOTS) {
    return invalid("window.hotRoots exceeds 256 roots");
  }
  const sealedCatchupRoots = decodePublicProjectionRoots(
    input["sealedCatchupRoots"],
    "window.sealedCatchupRoots",
  );
  if (sealedCatchupRoots.some((root) => root.state !== "sealed")) {
    return invalid("window.sealedCatchupRoots must contain only sealed roots");
  }
  const olderHistoryCursor = input["olderHistoryCursor"];
  return {
    type: CONVERSATION_WINDOW_FRAME_TYPE,
    conversationId: identity(input["conversationId"], "window.conversationId"),
    lineageId: identity(input["lineageId"], "window.lineageId"),
    basisRevision: decodeDurablePosition(input["basisRevision"], "window.basisRevision"),
    windowToken: token(input["windowToken"], "window.windowToken"),
    windowMode,
    archiveFrontierOrdinal: decodeDurablePosition(
      input["archiveFrontierOrdinal"],
      "window.archiveFrontierOrdinal",
    ),
    nextPublicPosition: decodeDurablePosition(
      input["nextPublicPosition"],
      "window.nextPublicPosition",
    ),
    hotRoots,
    sealedCatchupRoots,
    applicationState: json(input["applicationState"], "window.applicationState"),
    olderHistoryCursor:
      olderHistoryCursor === null ? null : token(olderHistoryCursor, "window.olderHistoryCursor"),
  };
}

export function decodePublicHistoryPage(value: unknown): PublicHistoryPage {
  const input = record(value, "historyPage");
  exactKeys(input, ["roots", "nextOlderCursor"], [], "historyPage");
  const next = input["nextOlderCursor"];
  return {
    roots: decodePublicProjectionRoots(input["roots"], "historyPage.roots"),
    nextOlderCursor: next === null ? null : token(next, "historyPage.nextOlderCursor"),
  };
}

export function compareDurablePositions(left: DurablePosition, right: DurablePosition): number {
  const a = BigInt(decodeDurablePosition(left, "left"));
  const b = BigInt(decodeDurablePosition(right, "right"));
  return a === b ? 0 : a < b ? -1 : 1;
}

export function isConversationWindowFrame(value: {
  readonly type: string;
}): value is ConversationWindowFrame {
  return value.type === CONVERSATION_WINDOW_FRAME_TYPE;
}
