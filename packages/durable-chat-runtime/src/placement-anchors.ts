import { decodePublicProjectionRoot, type PublicProjectionRoot } from "@sweatpants/chat-core";
import type {
  ConversationStore,
  PublicHistoryReadPage,
  PublicProjectionBasis,
} from "@sweatpants/history-store/contract";
import type { Operation } from "effection";

/** Enrich legacy context from the accepted archive, without rewriting immutable roots. */
export function* enrichPlacementAnchors(
  store: Pick<ConversationStore, "readPublicHistoryBefore">,
  conversationId: string,
  basis: PublicProjectionBasis,
  roots: readonly PublicProjectionRoot[],
): Operation<readonly PublicProjectionRoot[]> {
  const positions = new Map<string, string>();
  const missing = new Set<string>();
  for (const root of roots) {
    if (root.kind === "message") positions.set(root.message.id, root.position);
    const anchors =
      root.kind === "activity-subtree"
        ? root.anchors
        : root.placement.type === "root"
          ? []
          : root.placement.anchors;
    for (const anchor of anchors) {
      if (anchor.publicData.kind !== "message") continue;
      if (anchor.messagePosition !== undefined)
        positions.set(anchor.publicData.messageId, anchor.messagePosition);
      else missing.add(anchor.publicData.messageId);
    }
  }
  for (const id of positions.keys()) missing.delete(id);
  let beforePosition: string | null = basis.nextPublicPosition;
  while (missing.size > 0 && beforePosition !== null) {
    const page: PublicHistoryReadPage = yield* store.readPublicHistoryBefore({
      conversationId,
      basis,
      beforePosition,
      maxRoots: 100,
      maxBytes: 1024 * 1024,
    });
    for (const value of page.roots) {
      const root = decodePublicProjectionRoot(value);
      if (root.kind === "message" && missing.delete(root.message.id))
        positions.set(root.message.id, root.position);
    }
    beforePosition = page.nextBeforePosition;
  }
  if (missing.size > 0)
    throw new Error(`Missing archived placement for messages: ${[...missing].join(", ")}`);
  const enrich = (anchors: import("@sweatpants/chat-core").PublicPlacementAnchor[]) =>
    anchors.map((anchor) => {
      const position =
        anchor.publicData.kind === "message"
          ? positions.get(anchor.publicData.messageId)
          : undefined;
      return position === undefined ? anchor : { ...anchor, messagePosition: position };
    });
  return roots.map((root) =>
    root.kind === "activity-subtree"
      ? { ...root, anchors: enrich([...root.anchors]) }
      : root.placement.type === "root"
        ? root
        : {
            ...root,
            placement: { ...root.placement, anchors: enrich([...root.placement.anchors]) },
          },
  );
}
