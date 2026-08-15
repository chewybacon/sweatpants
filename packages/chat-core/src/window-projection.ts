import { EventType, type ActivitySnapshotEvent } from "@ag-ui/core";
import {
  appendAGUIMessage,
  createChatProjection,
  foldAGUIEvent,
  type ChatProjectionState,
} from "./chat-client-projection.ts";
import type { PublicPlacementAnchor, PublicProjectionRoot } from "./conversation-window.ts";
import { compareDurablePositions } from "./conversation-window.ts";

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

function ancestorFirstAnchors(
  anchors: ReadonlyMap<string, PublicPlacementAnchor>,
): readonly PublicPlacementAnchor[] {
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
}

/** Build one deterministic projection from complete positioned roots. */
export function projectionFromPublicRoots(
  roots: readonly PublicProjectionRoot[],
): ChatProjectionState {
  const ordered = [...roots].sort((left, right) =>
    compareDurablePositions(left.position, right.position),
  );
  const byId = new Map<string, PublicProjectionRoot>();
  const byPosition = new Map<string, PublicProjectionRoot>();
  const anchors = new Map<string, PublicPlacementAnchor>();
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
    for (const anchor of rootAnchors(root)) {
      const previous = anchors.get(anchor.nodeId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(anchor)) {
        throw new PublicRootConflictError(`Placement anchor ${anchor.nodeId} conflicts`);
      }
      anchors.set(anchor.nodeId, anchor);
    }
  }

  let state = createChatProjection();
  // Positioned message roots establish the durable transcript order before
  // activity anchors attach nested execution UI. An anchor may describe an
  // existing message, but it must never create a provisional message ahead of
  // an earlier positioned user/message root.
  for (const root of ordered) {
    if (root.kind === "message") state = appendAGUIMessage(state, root.message);
  }
  // Activity sequence is sibling-local, so sorting all anchors numerically can
  // publish a child before its lower-sequence parent. Replay each complete
  // anchor chain ancestor-first while retaining positioned-root insertion order
  // for otherwise unrelated branches.
  for (const anchor of ancestorFirstAnchors(anchors)) {
    state = foldAGUIEvent(state, anchorEvent(anchor));
  }
  for (const root of ordered) {
    if (root.kind !== "activity-subtree") continue;
    for (const node of [...root.nodes].sort(
      (left, right) => left.producerSequence - right.producerSequence,
    )) {
      state = foldAGUIEvent(state, node.event);
    }
  }
  return state;
}
