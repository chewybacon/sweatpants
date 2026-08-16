import { EventType, type AGUIEvent, type Message } from "@ag-ui/core";
import {
  CONVERSATION_WINDOW_FRAME_TYPE,
  buildAgUiCustomState,
  decodeAGUIEvent,
  decodePublicActivity,
  decodePublicProjectionRoot,
  type ConversationWindowFrame,
  type PublicActivityData,
  type PublicPlacementAnchor,
  type PublicProjectionBasis,
  type PublicProjectionRoot,
} from "@sweatpants/chat-core";
import { assertJson, canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import {
  assertCheckpointBounds,
  checkpointHotRoots,
  checkpointPayloadFromHotRoots,
  checkpointPublicApplicationState,
  DEFAULT_CHECKPOINT_TARGETS,
  rootPayloadBytes,
  segmentValues,
  type CheckpointPublicationTargets,
} from "@sweatpants/history-store";
import type {
  ArchivedPublicRootIndex,
  ConversationHead,
  ConversationHeadProposal,
  ConversationStore,
  PublicArchivePointer,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
} from "@sweatpants/history-store/contract";
import { ConversationStoreError } from "@sweatpants/history-store/contract";
import { call, type Operation } from "effection";
import { CrankError } from "@sweatpants/durable-execution";
import type { StreamEvent } from "./handler/types.ts";
import {
  mintPublicHistoryCursor,
  mintWindowToken,
  ProjectionTokenError,
  verifyWindowToken,
  type ProjectionTokenKeyring,
} from "./projection-tokens.ts";

export const DEFAULT_PROJECTION_TOKEN_TTL_MS = 15 * 60_000;
export const DEFAULT_HISTORY_PAGE_ROOT_LIMIT = 100;
export const DEFAULT_HISTORY_PAGE_BYTE_LIMIT = 1024 * 1024;

function numericSort(roots: readonly PublicProjectionRoot[]): PublicProjectionRoot[] {
  return [...roots].sort((left, right) => {
    const a = BigInt(left.position);
    const b = BigInt(right.position);
    return a === b ? 0 : a < b ? -1 : 1;
  });
}

export function publicProjectionBasis(
  head: ConversationHead,
  checkpoint: StoredCheckpoint,
  issuedAt: number,
  expiresAt: number,
): PublicProjectionBasis {
  const hotRoots = numericSort(
    checkpointHotRoots(checkpoint.payload).map((root) => decodePublicProjectionRoot(root)),
  );
  return {
    lineageId: checkpoint.lineageId,
    basisRevision: head.revision,
    archiveFrontierOrdinal: checkpoint.archiveFrontierOrdinal,
    nextPublicPosition: checkpoint.nextPublicPosition,
    hotRootPositions: hotRoots.map((root) => root.position),
    issuedAt,
    expiresAt,
  };
}

function sameBasis(left: PublicProjectionBasis, right: PublicProjectionBasis): boolean {
  return (
    left.lineageId === right.lineageId &&
    left.basisRevision === right.basisRevision &&
    left.archiveFrontierOrdinal === right.archiveFrontierOrdinal &&
    left.nextPublicPosition === right.nextPublicPosition &&
    left.hotRootPositions.length === right.hotRootPositions.length &&
    left.hotRootPositions.every((position, index) => position === right.hotRootPositions[index])
  );
}

function* sealedCatchupRoots(
  store: ConversationStore,
  conversationId: string,
  previous: PublicProjectionBasis,
  current: PublicProjectionBasis,
): Operation<readonly PublicProjectionRoot[] | null> {
  if (
    previous.lineageId !== current.lineageId ||
    BigInt(previous.archiveFrontierOrdinal) > BigInt(current.archiveFrontierOrdinal) ||
    BigInt(previous.nextPublicPosition) > BigInt(current.nextPublicPosition)
  ) {
    return null;
  }
  if (sameBasis(previous, current)) return [];
  const previousHot = new Set(previous.hotRootPositions);
  const currentHot = new Set(current.hotRootPositions);
  const missedPreviousHot = previous.hotRootPositions.filter(
    (position) => !currentHot.has(position),
  );
  const catchup = new Map<string, PublicProjectionRoot>();

  if (missedPreviousHot.length > 0) {
    const lower = missedPreviousHot.reduce((left, right) =>
      BigInt(left) < BigInt(right) ? left : right,
    );
    const page = yield* store.readPublicHistoryBefore({
      conversationId,
      basis: current,
      beforePosition: previous.nextPublicPosition,
      atOrAfterPosition: lower,
      maxRoots: 256,
      maxBytes: 8 * 1024 * 1024,
    });
    const byPosition = new Map(
      page.roots.map((root) => {
        const decoded = decodePublicProjectionRoot(root);
        return [decoded.position, decoded] as const;
      }),
    );
    for (const position of missedPreviousHot) {
      if (!previousHot.has(position)) continue;
      const root = byPosition.get(position);
      if (!root) {
        if (page.nextBeforePosition !== null) return null;
        throw new ConversationStoreError(
          "public_root_conflict",
          `Previously hot public position ${position} is absent from current authority`,
        );
      }
      if (root.state !== "sealed") {
        throw new ConversationStoreError(
          "public_root_conflict",
          `Previously hot public position ${position} archived before sealing`,
        );
      }
      catchup.set(position, root);
    }
  }

  const previousNext = BigInt(previous.nextPublicPosition);
  const currentNext = BigInt(current.nextPublicPosition);
  if (currentNext > previousNext) {
    // At most 256 current-hot positions can account for newly allocated roots.
    // A larger gap cannot produce a complete <=256-root catch-up.
    if (currentNext - previousNext > 512n) return null;
    const page = yield* store.readPublicHistoryBefore({
      conversationId,
      basis: current,
      beforePosition: current.nextPublicPosition,
      atOrAfterPosition: previous.nextPublicPosition,
      maxRoots: 256,
      maxBytes: 8 * 1024 * 1024,
    });
    if (page.nextBeforePosition !== null) return null;
    for (const value of page.roots) {
      const root = decodePublicProjectionRoot(value);
      if (root.state !== "sealed") {
        throw new ConversationStoreError(
          "public_root_conflict",
          `New public position ${root.position} archived before sealing`,
        );
      }
      catchup.set(root.position, root);
    }
    const currentNewHot = current.hotRootPositions.filter(
      (position) => BigInt(position) >= previousNext,
    ).length;
    if (BigInt(page.roots.length + currentNewHot) !== currentNext - previousNext) {
      throw new ConversationStoreError(
        "public_root_conflict",
        "New public position membership is incomplete under the selected basis",
      );
    }
  }

  const roots = numericSort([...catchup.values()]);
  if (
    roots.length > 256 ||
    rootPayloadBytes(roots.map((root) => assertJson(root))) > 8 * 1024 * 1024
  ) {
    return null;
  }
  return roots;
}

export function* buildConversationWindow(params: {
  store: ConversationStore;
  conversationId: string;
  head: ConversationHead;
  checkpoint: StoredCheckpoint;
  keyring: ProjectionTokenKeyring;
  knownWindowToken?: string;
  now?: number;
  tokenTtlMs?: number;
}): Operation<ConversationWindowFrame> {
  const now = params.now ?? Date.now();
  const expiresAt = now + (params.tokenTtlMs ?? DEFAULT_PROJECTION_TOKEN_TTL_MS);
  const basis = publicProjectionBasis(params.head, params.checkpoint, now, expiresAt);
  let catchup: readonly PublicProjectionRoot[] | null = null;
  if (params.knownWindowToken) {
    try {
      const previous = yield* call(() =>
        verifyWindowToken(params.knownWindowToken!, params.keyring, now),
      );
      catchup = yield* sealedCatchupRoots(params.store, params.conversationId, previous, basis);
    } catch (error) {
      if (error instanceof ProjectionTokenError) {
        catchup = null;
      } else {
        throw error;
      }
    }
  }
  const hotRoots = numericSort(
    checkpointHotRoots(params.checkpoint.payload).map((root) => decodePublicProjectionRoot(root)),
  );
  const windowToken = yield* call(() => mintWindowToken(basis, params.keyring));
  // Accepted archive membership is explicit in the checkpoint frontier. Do
  // not probe an archive body during hydration merely to decide whether the
  // first page cursor exists.
  const olderHistoryCursor =
    BigInt(params.checkpoint.archiveFrontierOrdinal) === 0n
      ? null
      : yield* call(() =>
          mintPublicHistoryCursor(
            { ...basis, beforePosition: params.checkpoint.nextPublicPosition },
            params.keyring,
          ),
        );
  return {
    type: CONVERSATION_WINDOW_FRAME_TYPE,
    conversationId: params.conversationId,
    lineageId: params.checkpoint.lineageId,
    basisRevision: params.head.revision,
    windowToken,
    windowMode: catchup === null ? "reset" : "continue",
    archiveFrontierOrdinal: params.checkpoint.archiveFrontierOrdinal,
    nextPublicPosition: params.checkpoint.nextPublicPosition,
    hotRoots,
    sealedCatchupRoots: catchup ?? [],
    applicationState: checkpointPublicApplicationState(params.checkpoint.payload),
    olderHistoryCursor,
  };
}

import { replayConversationViews } from "./projection.ts";

type ProjectionFrame = {
  readonly lsn: number;
  readonly event: AGUIEvent;
};

export class ConversationCheckpointConflictError extends Error {
  readonly code = "head_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ConversationCheckpointConflictError";
  }
}

export interface ConversationCheckpointRequest {
  readonly conversationId: string;
  readonly causeKey: string;
  readonly cause: Json;
  /** New accepted public AG-UI facts. They are compacted into typed roots before persistence. */
  readonly roots: readonly Json[];
  readonly applicationState?: Json;
  readonly proposal: Omit<
    ConversationHeadProposal,
    "checkpoint" | "terminalHistory" | "ownerTransition"
  > & {
    readonly ownerTransition?: ConversationHeadProposal["ownerTransition"];
    readonly terminalHistory?: ConversationHead["terminalHistory"];
  };
  readonly createdAt: number;
  readonly terminalHistorySegment?: StoredTerminalSegment;
  readonly targets?: CheckpointPublicationTargets;
  readonly expectedRevision?: string;
  readonly expectedOwnerEpoch?: string;
  readonly expectedExecutionId?: string | null;
}

export interface ConversationCheckpointResult {
  readonly checkpoint: StoredCheckpoint;
  readonly head: ConversationHead;
}

function counter(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid durable counter ${value}`);
  }
  return BigInt(value);
}

const PUBLIC_MESSAGE_ACCEPTED_FACT = "sweatpants.public-message-accepted.v1";

export function acceptedPublicMessageFact(message: Message): Json {
  return assertJson({ type: PUBLIC_MESSAGE_ACCEPTED_FACT, message });
}

function eventRoot(value: Json): value is Json & { readonly type: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value["type"] === "string"
  );
}

function acceptedPublicMessage(value: Json): Message | null {
  if (!eventRoot(value) || value.type !== PUBLIC_MESSAGE_ACCEPTED_FACT) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("message")) {
    throw new Error("Accepted public message fact has an invalid shape");
  }
  const record = value as Readonly<Record<string, Json>>;
  const decoded = decodeAGUIEvent({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [record["message"]],
  });
  if (decoded.type !== EventType.MESSAGES_SNAPSHOT || decoded.messages.length !== 1) {
    throw new Error("Accepted public message fact has an invalid message");
  }
  return decoded.messages[0]!;
}

function rootIdForMessage(message: Message): string {
  return `message:${message.id}`;
}

function rootIdForActivity(activityRecordId: string): string {
  return `activity:${activityRecordId}`;
}

function activityAnchor(
  event: Extract<AGUIEvent, { type: EventType.ACTIVITY_SNAPSHOT }>,
): PublicPlacementAnchor {
  const activity = decodePublicActivity(event.content);
  const data = activity.node.publicData;
  if (!data) {
    throw new Error(`Activity node ${activity.node.nodeId} has no public placement data`);
  }
  return {
    nodeId: activity.node.nodeId,
    parentNodeId: activity.node.parentNodeId,
    sequence: activity.node.sequence,
    kind: activity.node.kind,
    presentation: activity.node.presentation,
    publicData: data as PublicActivityData,
  };
}

function activityTerminal(
  event: Extract<AGUIEvent, { type: EventType.ACTIVITY_SNAPSHOT }>,
): boolean {
  const state = decodePublicActivity(event.content).node.state;
  return (
    state === "done" ||
    state === "output-available" ||
    state === "output-error" ||
    state === "complete" ||
    state === "error" ||
    state === "cancelled" ||
    state === "responded"
  );
}

function previousRootEvents(
  roots: readonly PublicProjectionRoot[],
  applicationState: Json,
): AGUIEvent[] {
  const messages = roots
    .filter(
      (root): root is Extract<PublicProjectionRoot, { kind: "message" }> => root.kind === "message",
    )
    .sort((left, right) => (counter(left.position) < counter(right.position) ? -1 : 1))
    .map((root) => root.message);
  const activities = roots
    .filter(
      (root): root is Extract<PublicProjectionRoot, { kind: "activity-subtree" }> =>
        root.kind === "activity-subtree",
    )
    .flatMap((root) => root.nodes.map((node) => node.event));
  return [
    { type: EventType.MESSAGES_SNAPSHOT, messages },
    ...activities,
    { type: EventType.STATE_SNAPSHOT, snapshot: applicationState },
  ];
}

function ancestorAnchors(
  event: Extract<AGUIEvent, { type: EventType.ACTIVITY_SNAPSHOT }>,
  byNodeId: ReadonlyMap<string, Extract<AGUIEvent, { type: EventType.ACTIVITY_SNAPSHOT }>>,
): readonly PublicPlacementAnchor[] {
  const result: PublicPlacementAnchor[] = [];
  const seen = new Set<string>();
  let parentId = decodePublicActivity(event.content).node.parentNodeId;
  while (parentId !== null) {
    if (seen.has(parentId)) {
      throw new Error(`Public activity placement contains a cycle at ${parentId}`);
    }
    seen.add(parentId);
    const parent = byNodeId.get(parentId);
    if (!parent) {
      throw new Error(`Public activity node ${parentId} is missing its placement anchor`);
    }
    result.push(activityAnchor(parent));
    parentId = decodePublicActivity(parent.content).node.parentNodeId;
  }
  result.reverse();
  return result;
}

function assignPositions(
  roots: readonly Omit<PublicProjectionRoot, "position">[],
  previous: readonly PublicProjectionRoot[],
  nextPosition: bigint,
): { readonly roots: readonly PublicProjectionRoot[]; readonly nextPosition: bigint } {
  const previousById = new Map(previous.map((root) => [root.rootId, root]));
  const result: PublicProjectionRoot[] = [];
  let next = nextPosition;
  for (const root of roots) {
    const prior = previousById.get(root.rootId);
    const positioned = {
      ...root,
      position: prior?.position ?? next.toString(10),
    } as PublicProjectionRoot;
    if (!prior) next += 1n;
    result.push(decodePublicProjectionRoot(positioned));
  }
  result.sort((left, right) => {
    const a = counter(left.position);
    const b = counter(right.position);
    return a === b ? 0 : a < b ? -1 : 1;
  });
  return { roots: result, nextPosition: next };
}

function* compactPublicRoots(params: {
  previous: readonly PublicProjectionRoot[];
  newFacts: readonly Json[];
  applicationState: Json;
  nextPosition: bigint;
  logicalTurnId: string | null;
  executionId: string | null;
}): Operation<{
  readonly roots: readonly PublicProjectionRoot[];
  readonly nextPosition: bigint;
  readonly applicationState: Json;
}> {
  const acceptedMessages = params.newFacts.flatMap((fact) => {
    const message = acceptedPublicMessage(fact);
    return message ? [message] : [];
  });
  const newEvents = params.newFacts.filter(
    (fact) => eventRoot(fact) && fact.type !== PUBLIC_MESSAGE_ACCEPTED_FACT,
  ) as unknown as AGUIEvent[];
  const allEvents: AGUIEvent[] = [
    ...previousRootEvents(params.previous, params.applicationState),
    ...newEvents,
  ];
  const frames: ProjectionFrame[] = allEvents.map((event, index) => ({
    lsn: index + 1,
    event,
  }));
  // One replay supplies both the checkpoint snapshot and the projected
  // messages. Replaying here and then calling providerHistoryFromFrames()
  // would fold the complete frame set a second time.
  const views = replayConversationViews(frames);
  const snapshots: StreamEvent[] = [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...views.providerMessages],
    },
    ...views.activitySnapshots,
  ];
  const projectedMessages = views.providerMessages;
  const previousMessages = params.previous
    .filter(
      (root): root is Extract<PublicProjectionRoot, { kind: "message" }> => root.kind === "message",
    )
    .map((root) => root.message);
  const projectedById = new Map(projectedMessages.map((message) => [message.id, message]));
  const seenMessageIds = new Set<string>();
  const messages: Message[] = [];
  for (const message of [
    ...previousMessages.map((prev) => projectedById.get(prev.id) ?? prev),
    ...projectedMessages,
    ...acceptedMessages,
  ]) {
    if (seenMessageIds.has(message.id)) continue;
    seenMessageIds.add(message.id);
    messages.push(message);
  }
  const terminal = newEvents.some(
    (event) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR,
  );
  const ended = new Set(
    allEvents.flatMap((event) =>
      event.type === EventType.TEXT_MESSAGE_END || event.type === EventType.REASONING_MESSAGE_END
        ? [event.messageId]
        : [],
    ),
  );
  const snapshotMessageIds = new Set([
    ...acceptedMessages.map((message) => message.id),
    ...allEvents.flatMap((event) =>
      event.type === EventType.MESSAGES_SNAPSHOT ? event.messages.map((message) => message.id) : [],
    ),
  ]);
  const previousById = new Map(params.previous.map((root) => [root.rootId, root]));
  const messageRoots: Array<Omit<PublicProjectionRoot, "position">> = messages.map(
    (message, sequence) => {
      const rootId = rootIdForMessage(message);
      const prior = previousById.get(rootId);
      const sealed =
        prior?.state === "sealed" ||
        snapshotMessageIds.has(message.id) ||
        message.role === "user" ||
        message.role === "tool" ||
        ended.has(message.id) ||
        terminal;
      return {
        rootId,
        kind: "message",
        state: sealed ? "sealed" : "mutable",
        attribution: {},
        ...(params.logicalTurnId ? { logicalTurnId: params.logicalTurnId } : {}),
        ...(params.executionId ? { executionId: params.executionId } : {}),
        message,
        placement:
          message.role === "tool"
            ? { type: "tool-result", toolCallId: message.toolCallId, anchors: [] }
            : { type: "root", sequence },
      } as Omit<PublicProjectionRoot, "position">;
    },
  );

  const activityEvents = snapshots.filter(
    (event): event is Extract<AGUIEvent, { type: EventType.ACTIVITY_SNAPSHOT }> =>
      event.type === EventType.ACTIVITY_SNAPSHOT,
  );
  const byNodeId = new Map(
    activityEvents.map((event) => [decodePublicActivity(event.content).node.nodeId, event]),
  );
  const activityRoots: Array<Omit<PublicProjectionRoot, "position">> = activityEvents.map(
    (event) => {
      const activity = decodePublicActivity(event.content);
      const rootId = rootIdForActivity(event.messageId);
      const prior = previousById.get(rootId);
      const producerSequence =
        activity.node.publicData?.kind === "elicit"
          ? activity.node.publicData.producerSequence
          : activity.node.sequence;
      return {
        rootId,
        kind: "activity-subtree",
        state: prior?.state === "sealed" || activityTerminal(event) ? "sealed" : "mutable",
        attribution: {},
        ...(params.logicalTurnId ? { logicalTurnId: params.logicalTurnId } : {}),
        ...(params.executionId ? { executionId: params.executionId } : {}),
        rootNodeId: activity.node.nodeId,
        producerSequence,
        anchors: ancestorAnchors(event, byNodeId),
        nodes: [{ activityRecordId: event.messageId, producerSequence, event }],
        unloadedDescendantCount: 0,
      } as Omit<PublicProjectionRoot, "position">;
    },
  );
  const latestState = [...allEvents]
    .reverse()
    .find((event) => event.type === EventType.STATE_SNAPSHOT);
  return {
    ...assignPositions([...messageRoots, ...activityRoots], params.previous, params.nextPosition),
    applicationState:
      latestState?.type === EventType.STATE_SNAPSHOT
        ? assertJson(latestState.snapshot)
        : params.applicationState,
  };
}

function spillRoots(
  roots: readonly PublicProjectionRoot[],
  target: CheckpointPublicationTargets["spill"],
): {
  readonly spilled: readonly PublicProjectionRoot[];
  readonly hotRoots: readonly PublicProjectionRoot[];
} {
  const hot = [...roots];
  const spilled: PublicProjectionRoot[] = [];
  const over = () =>
    hot.length > target.maxRoots ||
    rootPayloadBytes(hot.map((root) => assertJson(root))) > target.maxEncodedBytes;
  while (over()) {
    const index = hot.findIndex((root) => root.state === "sealed");
    if (index < 0) break;
    spilled.push(hot[index]!);
    hot.splice(index, 1);
  }
  return { spilled, hotRoots: hot };
}

function planArchiveSegments(
  conversationId: string,
  previous: PublicArchivePointer | null,
  roots: readonly PublicProjectionRoot[],
  firstArchiveOrdinal: bigint,
  createdAt: number,
  targets: CheckpointPublicationTargets,
): {
  readonly archiveHead: PublicArchivePointer | null;
  readonly archiveFrontierOrdinal: bigint;
  readonly segments: readonly StoredPublicArchiveSegment[];
  readonly index: readonly ArchivedPublicRootIndex[];
} {
  let archiveHead = previous;
  let archiveOrdinal = firstArchiveOrdinal;
  const segments: StoredPublicArchiveSegment[] = [];
  const index: ArchivedPublicRootIndex[] = [];
  for (const batch of segmentValues(
    roots.map((root) => assertJson(root)),
    targets.segment,
  )) {
    const typed = batch.entries.map((root) => decodePublicProjectionRoot(root));
    const positions = typed.map((root) => counter(root.position));
    const minPosition = positions.reduce((left, right) => (left < right ? left : right));
    const maxPosition = positions.reduce((left, right) => (left > right ? left : right));
    const encoded = canonicalSnapshot(batch.entries);
    const segment: StoredPublicArchiveSegment = {
      segmentId: stableTupleHash([conversationId, archiveOrdinal.toString(10), encoded.sha]),
      conversationId,
      previous: archiveHead,
      minPosition: minPosition.toString(10),
      maxPosition: maxPosition.toString(10),
      roots: batch.entries,
      contentHash: encoded.sha,
      encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
      createdAt,
    };
    segments.push(segment);
    typed.forEach((root, segmentRootIndex) => {
      const snapshot = canonicalSnapshot(root as unknown as Json);
      index.push({
        conversationId,
        position: root.position,
        rootId: root.rootId,
        segmentId: segment.segmentId,
        segmentRootIndex,
        archiveOrdinal: archiveOrdinal.toString(10),
        contentHash: snapshot.sha,
        encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
      });
      archiveOrdinal += 1n;
    });
    archiveHead = { segmentId: segment.segmentId };
  }
  return { archiveHead, archiveFrontierOrdinal: archiveOrdinal, segments, index };
}

/**
 * Proves the next command checkpoint is representable without publishing a
 * receipt, head transition, private task, or response-tail state. This is an
 * admission preflight; the store still repeats the same bounds check when the
 * eventual checkpoint is committed.
 */
export function* preflightConversationCheckpoint(params: {
  readonly store: ConversationStore;
  readonly conversationId: string;
  readonly roots: readonly Json[];
  readonly applicationState?: Json;
  readonly logicalTurnId: string | null;
  readonly executionId: string | null;
  readonly targets?: CheckpointPublicationTargets;
  readonly openInterrupts?: number;
  readonly expectedRevision?: string | null;
  readonly expectedOwnerEpoch?: string;
  readonly expectedExecutionId?: string | null;
}): Operation<void> {
  const targets = params.targets ?? DEFAULT_CHECKPOINT_TARGETS;
  const head = yield* params.store.loadHead(params.conversationId);
  if (
    head &&
    ((params.expectedRevision !== undefined && head.revision !== params.expectedRevision) ||
      (params.expectedOwnerEpoch !== undefined && head.ownerEpoch !== params.expectedOwnerEpoch) ||
      (params.expectedExecutionId !== undefined &&
        head.activeExecutionId !== null &&
        head.activeExecutionId !== params.expectedExecutionId))
  ) {
    throw new ConversationCheckpointConflictError(
      `Conversation ${params.conversationId} changed before admission preflight`,
    );
  }
  const previousCheckpoint = head?.checkpoint
    ? yield* params.store.getCheckpoint(head.checkpoint)
    : null;
  const previousHot = (
    previousCheckpoint ? checkpointHotRoots(previousCheckpoint.payload) : []
  ).map((root) => decodePublicProjectionRoot(root));
  const previousApplicationState = previousCheckpoint
    ? checkpointPublicApplicationState(previousCheckpoint.payload)
    : (params.applicationState ?? assertJson(buildAgUiCustomState({})));
  const compacted = yield* compactPublicRoots({
    previous: previousHot,
    newFacts: params.roots,
    applicationState: params.applicationState ?? previousApplicationState,
    nextPosition: counter(previousCheckpoint?.nextPublicPosition ?? "0"),
    logicalTurnId: params.logicalTurnId,
    executionId: params.executionId,
  });
  const { hotRoots } = spillRoots(compacted.roots, targets.spill);
  const payload = canonicalSnapshot(
    checkpointPayloadFromHotRoots(
      hotRoots.map((root) => assertJson(root)),
      compacted.applicationState,
    ),
  );
  const largestInlineRootBytes = Math.max(
    0,
    ...hotRoots.map(
      (root) => new TextEncoder().encode(canonicalSnapshot(assertJson(root)).canonical).byteLength,
    ),
  );
  try {
    assertCheckpointBounds({
      encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
      totalRoots: hotRoots.length,
      mutableRoots: hotRoots.filter((root) => root.state === "mutable").length,
      openInterrupts: params.openInterrupts ?? 0,
      largestInlineRootBytes,
    });
  } catch (error) {
    if (error instanceof ConversationStoreError && error.code === "checkpoint_bound_exceeded") {
      throw new CrankError("checkpoint_bound_exceeded", error.message);
    }
    throw error;
  }
}

export function* persistConversationCheckpoint(
  store: ConversationStore,
  request: ConversationCheckpointRequest,
): Operation<ConversationCheckpointResult> {
  const targets = request.targets ?? DEFAULT_CHECKPOINT_TARGETS;
  const head = yield* store.loadHead(request.conversationId);
  if (!head) throw new Error(`Conversation ${request.conversationId} has no admitted head`);
  if (
    (request.expectedRevision !== undefined && head.revision !== request.expectedRevision) ||
    (request.expectedOwnerEpoch !== undefined && head.ownerEpoch !== request.expectedOwnerEpoch) ||
    (request.expectedExecutionId !== undefined &&
      head.activeExecutionId !== null &&
      head.activeExecutionId !== request.expectedExecutionId)
  ) {
    throw new ConversationCheckpointConflictError(
      `Conversation ${request.conversationId} changed before checkpoint publication`,
    );
  }
  const previousCheckpoint = head.checkpoint ? yield* store.getCheckpoint(head.checkpoint) : null;
  const previousHot = (
    previousCheckpoint ? checkpointHotRoots(previousCheckpoint.payload) : []
  ).map((root) => decodePublicProjectionRoot(root));
  const previousApplicationState = previousCheckpoint
    ? checkpointPublicApplicationState(previousCheckpoint.payload)
    : (request.applicationState ?? assertJson(buildAgUiCustomState({})));
  const compacted = yield* compactPublicRoots({
    previous: previousHot,
    newFacts: request.roots,
    applicationState: request.applicationState ?? previousApplicationState,
    nextPosition: counter(previousCheckpoint?.nextPublicPosition ?? "0"),
    logicalTurnId: request.proposal.activeLogicalTurnId,
    executionId: request.proposal.activeExecutionId,
  });
  const { spilled, hotRoots } = spillRoots(compacted.roots, targets.spill);
  const archive = planArchiveSegments(
    request.conversationId,
    previousCheckpoint?.archiveHead ?? null,
    spilled,
    counter(previousCheckpoint?.archiveFrontierOrdinal ?? "0"),
    request.createdAt,
    targets,
  );
  const payloadValue = checkpointPayloadFromHotRoots(
    hotRoots.map((root) => assertJson(root)),
    compacted.applicationState,
  );
  const payload = canonicalSnapshot(payloadValue);
  const cause = canonicalSnapshot(request.cause);
  const lineageId =
    previousCheckpoint?.lineageId ??
    stableTupleHash(["sweatpants.conversation-lineage", request.conversationId, request.causeKey]);
  const checkpoint: StoredCheckpoint = {
    checkpointId: stableTupleHash([request.conversationId, request.causeKey, payload.sha]),
    conversationId: request.conversationId,
    lineageId,
    causeKey: request.causeKey,
    cause: cause.value,
    contentHash: payload.sha,
    archiveHead: archive.archiveHead,
    archiveFrontierOrdinal: archive.archiveFrontierOrdinal.toString(10),
    nextPublicPosition: compacted.nextPosition.toString(10),
    payload: payload.value,
    encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
    createdAt: request.createdAt,
  };
  const proposal: ConversationHeadProposal = {
    ...request.proposal,
    checkpoint: { checkpointId: checkpoint.checkpointId },
    terminalHistory: request.proposal.terminalHistory ?? head.terminalHistory,
    ownerTransition: request.proposal.ownerTransition ?? { kind: "preserve" },
  };
  const committed = yield* store.commitConversation({
    conversationId: request.conversationId,
    expectedRevision: request.expectedRevision ?? head.revision,
    expectedOwnerEpoch: request.expectedOwnerEpoch ?? head.ownerEpoch,
    proposal,
    publicArchiveSegments: archive.segments,
    publicArchiveRootIndex: archive.index,
    checkpoint,
    ...(request.terminalHistorySegment
      ? { terminalHistorySegment: request.terminalHistorySegment }
      : {}),
    updatedAt: request.createdAt,
  });
  if (committed.status !== "committed") {
    throw new ConversationCheckpointConflictError(
      `Conversation ${request.conversationId} checkpoint head CAS lost`,
    );
  }
  return { checkpoint, head: committed.head };
}

/** Returns only the bounded current hot window. */
export function hydratePublicRoots(checkpoint: StoredCheckpoint): readonly Json[] {
  return checkpointHotRoots(checkpoint.payload);
}

/** Reads immutable archived roots in bounded pages for server-side model planning only. */
export function* readAllPublicRootsForModel(
  store: ConversationStore,
  conversationId: string,
  checkpoint: StoredCheckpoint,
  maxCanonicalBytes: number,
): Operation<readonly Json[]> {
  if (!Number.isSafeInteger(maxCanonicalBytes) || maxCanonicalBytes <= 0) {
    throw new CrankError(
      "model_context_limit_exceeded",
      "Model context read budget must be a positive finite integer",
    );
  }
  const archived: Json[] = [];
  const hotMessages = checkpointHotRoots(checkpoint.payload).filter(
    (root) => decodePublicProjectionRoot(root).kind === "message",
  );
  let materializedBytes = hotMessages.reduce<number>(
    (total, root) => total + new TextEncoder().encode(canonicalSnapshot(root).canonical).byteLength,
    0,
  );
  if (materializedBytes > maxCanonicalBytes) {
    throw new CrankError(
      "model_context_limit_exceeded",
      `Model context roots exceed byte budget ${maxCanonicalBytes}`,
    );
  }
  let beforePosition = checkpoint.nextPublicPosition;
  while (true) {
    const page = yield* store.readPublicHistoryBefore({
      conversationId,
      basis: {
        lineageId: checkpoint.lineageId,
        basisRevision: "0",
        archiveFrontierOrdinal: checkpoint.archiveFrontierOrdinal,
        nextPublicPosition: checkpoint.nextPublicPosition,
        hotRootPositions: checkpointHotRoots(checkpoint.payload).map(
          (root) => decodePublicProjectionRoot(root).position,
        ),
      },
      beforePosition,
      maxRoots: 100,
      maxBytes: 1024 * 1024,
    });
    const pageMessages = page.roots.filter(
      (root) => decodePublicProjectionRoot(root).kind === "message",
    );
    for (const root of pageMessages) {
      materializedBytes += new TextEncoder().encode(canonicalSnapshot(root).canonical).byteLength;
      if (materializedBytes > maxCanonicalBytes) {
        throw new CrankError(
          "model_context_limit_exceeded",
          `Model context roots exceed byte budget ${maxCanonicalBytes}`,
        );
      }
    }
    archived.unshift(...pageMessages);
    if (page.nextBeforePosition === null) break;
    beforePosition = page.nextBeforePosition;
  }
  return [...archived, ...hotMessages];
}
