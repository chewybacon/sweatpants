import {
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import { EventType, type ActivitySnapshotEvent } from "@ag-ui/core";
import {
  appendAGUIMessages,
  createChatProjection,
  foldAGUIEvents,
  type ChatProjectionState,
} from "./chat-client-projection.ts";
import type { PublicPlacementAnchor, PublicProjectionRoot } from "./conversation-window.ts";
import { compareDurablePositions } from "./conversation-window.ts";
import { decodePublicActivity } from "./chat-client-codec.ts";

export class PublicRootConflictError extends Error {
  readonly code = "public_root_conflict";

  constructor(message: string) {
    super(message);
    this.name = "PublicRootConflictError";
  }
}

function anchorState(anchor: PublicPlacementAnchor): string {
  const data = anchor.publicData;
  if (data.kind === "message") return "done";
  if (data.kind === "elicit") return "pending";
  if (data.kind === "activity") return "complete";
  if (data.errorText !== undefined) return "output-error";
  if (data.output !== undefined) return "output-available";
  if (data.input !== undefined) return "input-available";
  return "input-streaming";
}

function anchorEvent(anchor: PublicPlacementAnchor): ActivitySnapshotEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: `anchor:${anchor.nodeId}`,
    activityType: "sweatpants:public-execution",
    content: {
      version: 1,
      node: {
        nodeId: anchor.nodeId,
        parentNodeId: anchor.parentNodeId,
        sequence: anchor.sequence,
        kind: anchor.kind,
        state: anchorState(anchor),
        presentation: anchor.presentation,
        publicData: anchor.publicData,
      },
    },
    replace: true,
  } as ActivitySnapshotEvent;
}

function rootAnchors(root: PublicProjectionRoot): readonly PublicPlacementAnchor[] {
  if (root.kind === "activity-subtree") return root.anchors;
  return root.placement.type === "root" ? [] : root.placement.anchors;
}

/** Evidence emitted while projecting public roots. */
export type PublicRootProjectionNote =
  | { readonly kind: "roots-indexed"; readonly roots: number; readonly anchors: number }
  | { readonly kind: "messages-seeded"; readonly messages: number }
  | { readonly kind: "anchors-attached"; readonly anchors: number }
  | { readonly kind: "activities-applied"; readonly nodes: number };

/**
 * Roots proven unique by identity and position, with their placement anchors
 * merged. Later stages rely on that proof instead of rechecking it.
 */
interface IndexedPublicRoots {
  readonly ordered: readonly PublicProjectionRoot[];
  readonly anchors: ReadonlyMap<string, PublicPlacementAnchor>;
}

type Note = PublicRootProjectionNote;

/** Order by durable position, then prove root and anchor identity agree. */
function* indexRoots(
  roots: readonly PublicProjectionRoot[],
): ProjectionProgram<IndexedPublicRoots, Note> {
  return yield* stage("index-roots", function* () {
    const ordered = [...roots].sort((left, right) =>
      compareDurablePositions(left.position, right.position),
    );
    const byId = new Map<string, PublicProjectionRoot>();
    const byPosition = new Map<string, PublicProjectionRoot>();
    const anchors = new Map<string, PublicPlacementAnchor>();
    const bodies = new Map(
      ordered.flatMap((root) =>
        root.kind === "activity-subtree"
          ? root.nodes.map(({ event }) => {
              const node = decodePublicActivity(event.content).node;
              return [node.nodeId, node] as const;
            })
          : [],
      ),
    );

    for (const root of ordered) {
      const sameId = byId.get(root.rootId);
      const samePosition = byPosition.get(root.position);
      if (
        (sameId && JSON.stringify(sameId) !== JSON.stringify(root)) ||
        (samePosition && samePosition.rootId !== root.rootId)
      ) {
        throw new PublicRootConflictError(
          `Public root ${root.rootId}/${root.position} conflicts with loaded projection`,
        );
      }
      byId.set(root.rootId, root);
      byPosition.set(root.position, root);

      for (const hint of rootAnchors(root)) {
        const body = bodies.get(hint.nodeId);
        // Archived descendants retain placement hints captured before a parent
        // settled. A loaded parent body owns its current public data.
        if (
          body &&
          (body.parentNodeId !== hint.parentNodeId ||
            body.sequence !== hint.sequence ||
            body.kind !== hint.kind ||
            body.presentation !== hint.presentation ||
            (body.publicData?.kind === "tool-call" &&
              (hint.publicData.kind !== "tool-call" ||
                body.publicData.callId !== hint.publicData.callId ||
                body.publicData.name !== hint.publicData.name)))
        ) {
          throw new PublicRootConflictError(
            `Placement anchor ${hint.nodeId} conflicts with its body`,
          );
        }
        const anchor = body?.publicData ? { ...hint, publicData: body.publicData } : hint;
        const previous = anchors.get(anchor.nodeId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(anchor)) {
          throw new PublicRootConflictError(`Placement anchor ${anchor.nodeId} conflicts`);
        }
        anchors.set(anchor.nodeId, anchor);
      }
    }

    yield* note({ kind: "roots-indexed", roots: ordered.length, anchors: anchors.size });
    return { ordered, anchors };
  });
}

/**
 * Activity sequence is sibling-local, so sorting all anchors numerically can
 * publish a child before its lower-sequence parent. Replay each complete anchor
 * chain ancestor-first instead.
 */
function* orderAnchors(
  anchors: ReadonlyMap<string, PublicPlacementAnchor>,
): ProjectionProgram<readonly PublicPlacementAnchor[], Note> {
  return yield* stage("order-anchors", function* () {
    const ordered: PublicPlacementAnchor[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (anchor: PublicPlacementAnchor): void => {
      if (visited.has(anchor.nodeId)) return;
      if (visiting.has(anchor.nodeId)) {
        throw new PublicRootConflictError(`Placement anchor ${anchor.nodeId} is cyclic`);
      }
      visiting.add(anchor.nodeId);
      if (anchor.parentNodeId !== null) {
        const parent = anchors.get(anchor.parentNodeId);
        if (parent) visit(parent);
      }
      visiting.delete(anchor.nodeId);
      visited.add(anchor.nodeId);
      ordered.push(anchor);
    };
    for (const anchor of anchors.values()) visit(anchor);
    return ordered;
  });
}

/**
 * Positioned message roots establish the durable transcript order before
 * activity anchors attach nested execution UI. An anchor may describe an
 * existing message, but it must never create a provisional message ahead of an
 * earlier positioned user/message root.
 */
function* seedMessages(indexed: IndexedPublicRoots): ProjectionProgram<ChatProjectionState, Note> {
  return yield* stage("seed-messages", function* () {
    const messages = indexed.ordered.flatMap((root) =>
      root.kind === "message" ? [root.message] : [],
    );
    const state = appendAGUIMessages(createChatProjection(), messages);
    yield* note({ kind: "messages-seeded", messages: messages.length });
    return state;
  });
}

function* attachAnchors(
  state: ChatProjectionState,
  anchors: readonly PublicPlacementAnchor[],
): ProjectionProgram<ChatProjectionState, Note> {
  return yield* stage("attach-anchors", function* () {
    const current = foldAGUIEvents(state, anchors.map(anchorEvent));
    yield* note({ kind: "anchors-attached", anchors: anchors.length });
    return current;
  });
}

function* applyActivities(
  state: ChatProjectionState,
  indexed: IndexedPublicRoots,
): ProjectionProgram<ChatProjectionState, Note> {
  return yield* stage("apply-activities", function* () {
    const events = indexed.ordered.flatMap((root) =>
      root.kind === "activity-subtree"
        ? [...root.nodes]
            .sort((left, right) => left.producerSequence - right.producerSequence)
            .map((node) => node.event)
        : [],
    );
    const current = foldAGUIEvents(state, events);
    yield* note({ kind: "activities-applied", nodes: events.length });
    return current;
  });
}

/**
 * The public-root projection as one program. Callers that want stage evidence
 * or the failing stage path run this with `runProjectionProgram`; callers that
 * only want the projection use {@link projectionFromPublicRoots}.
 */
export function* publicRootProjection(
  roots: readonly PublicProjectionRoot[],
): ProjectionProgram<ChatProjectionState, PublicRootProjectionNote> {
  const indexed = yield* indexRoots(roots);
  const anchors = yield* orderAnchors(indexed.anchors);
  const seeded = yield* seedMessages(indexed);
  const attached = yield* attachAnchors(seeded, anchors);
  const applied = yield* applyActivities(attached, indexed);
  // Context-only parents must share the same durable ordering as loaded bodies.
  const positions = new Map<string, string>();
  for (const anchor of anchors) {
    if (anchor.publicData.kind === "message" && anchor.messagePosition !== undefined) {
      positions.set(anchor.publicData.messageId, anchor.messagePosition);
    }
  }
  for (const root of indexed.ordered) {
    if (root.kind !== "message") continue;
    const position = positions.get(root.message.id);
    if (position !== undefined && position !== root.position) {
      throw new PublicRootConflictError(
        `Message ${root.message.id} has conflicting placement positions`,
      );
    }
    positions.set(root.message.id, root.position);
  }
  return {
    ...applied,
    messageOrder: [...applied.messageOrder].sort((a, b) => {
      const left = positions.get(a);
      const right = positions.get(b);
      // Legacy callers retain insertion order until the server enriches anchors.
      return left === undefined || right === undefined ? 0 : compareDurablePositions(left, right);
    }),
  };
}

/** Build one deterministic projection from complete positioned roots. */
export function projectionFromPublicRoots(
  roots: readonly PublicProjectionRoot[],
): ChatProjectionState {
  const outcome = runProjectionProgram(
    () => publicRootProjection(roots),
    (error) => error,
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
