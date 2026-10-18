import type { Operation } from "effection";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import type {
  ConversationStore,
  StoredCheckpoint,
  PublicHistoryReadPage,
} from "@sweatpants/history-store/contract";
import { checkpointHotRoots } from "@sweatpants/history-store";
import { decodePublicProjectionRoot, type PublicProjectionRoot } from "@sweatpants/chat-core";
import { indexChatJournal, type ChatJournalIndex } from "./program-driver-chat-journal-index.ts";
import { jsonRecord } from "./program-driver-chat-projection-codecs.ts";

function recordOwner(record: DurableSemanticRecord, index: ChatJournalIndex): string | undefined {
  const payload = record.payload;
  if (payload.type === "AssistantPartialAccepted") {
    return payload.fact.messageId;
  }
  if (payload.type !== "DurableEmission") {
    return undefined;
  }
  if (payload.descriptor.eventType === "assistant_text") {
    return index.modelMessageIds.get(record) ?? undefined;
  }
  const data = jsonRecord(payload.descriptor.payload);
  return typeof data?.["callId"] === "string"
    ? index.toolMessageIds.get(data["callId"])
    : undefined;
}

function rootIdentities(root: PublicProjectionRoot): string[] {
  return root.kind === "message"
    ? [root.message.id]
    : root.nodes.map((node) => node.activityRecordId);
}

/** Check accepted public membership, including spilled roots, without retaining archive bodies. */
export function* publishedJournalOwners(
  store: ConversationStore,
  conversationId: string,
  checkpoint: StoredCheckpoint | null,
  records: DurableSemanticRecord[],
): Operation<ReadonlySet<string>> {
  const index = indexChatJournal(records);
  const missing = new Set(
    records.flatMap((record) => {
      const owner = recordOwner(record, index);
      return owner ? [owner] : [];
    }),
  );
  const published = new Set<string>();
  const hot = checkpoint
    ? checkpointHotRoots(checkpoint.payload).map((value) => decodePublicProjectionRoot(value))
    : [];
  const observe = (roots: readonly PublicProjectionRoot[]) => {
    for (const root of roots) {
      for (const id of rootIdentities(root)) {
        if (missing.delete(id)) {
          published.add(id);
        }
      }
    }
  };
  observe(hot);
  if (!checkpoint || checkpoint.archiveFrontierOrdinal === "0") {
    return published;
  }
  let beforePosition: string | null = checkpoint.nextPublicPosition;
  while (missing.size > 0 && beforePosition !== null) {
    const page: PublicHistoryReadPage = yield* store.readPublicHistoryBefore({
      conversationId,
      basis: {
        lineageId: checkpoint.lineageId,
        basisRevision: "0",
        archiveFrontierOrdinal: checkpoint.archiveFrontierOrdinal,
        nextPublicPosition: checkpoint.nextPublicPosition,
        hotRootPositions: hot.map((root) => root.position),
      },
      beforePosition,
      maxRoots: 100,
      maxBytes: 1024 * 1024,
    });
    observe(page.roots.map((value) => decodePublicProjectionRoot(value)));
    beforePosition = page.nextBeforePosition;
  }
  return published;
}

/** Journal acceptance is not proof of publication: recover the unexposed prefix too. */
export function recordsForPublication(
  before: DurableSemanticRecord[],
  after: DurableSemanticRecord[],
  publishedOwners: ReadonlySet<string>,
  retainedActivityIds: ReadonlySet<string>,
): DurableSemanticRecord[] {
  const index = indexChatJournal(after);
  const recovered = before.filter((record) => {
    const payload = record.payload;
    if (payload.type === "PullResolved") {
      return (
        retainedActivityIds.has(`elicit:${payload.pullId}`) &&
        index.pullRequests.get(payload.pullId)?.descriptor.kind === "elicit"
      );
    }
    const owner = recordOwner(record, index);
    if (owner && !publishedOwners.has(owner)) {
      return true;
    }
    // A host can accept completion before losing its publication. Replacing a
    // retained owner's terminal state is safe; archived owners stay archived.
    return (
      owner !== undefined &&
      retainedActivityIds.has(owner) &&
      payload.type === "DurableEmission" &&
      payload.descriptor.eventType === "tool_completed"
    );
  });
  return [...recovered, ...after.slice(before.length)];
}
