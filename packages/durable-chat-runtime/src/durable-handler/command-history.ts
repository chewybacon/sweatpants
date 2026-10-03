import {
  type ConversationStreamEvent as StreamEvent,
  agUiMessagesToChatHistoryEntries,
  decodePublicProjectionRoot,
  type ChatHistoryEntry,
  type ConversationCommand,
  type PublicProjectionRoot,
} from "@sweatpants/chat-core";
import { CrankError } from "@sweatpants/durable-execution";
import { stableTupleHash, type Json } from "@sweatpants/foundation";
import type { ConversationHead } from "@sweatpants/history-store/contract";
import { useConversationStore } from "@sweatpants/history-store/port";
import type { Operation } from "effection";
import { readAllPublicRootsForModel } from "../conversation-persistence.ts";

function historyEntriesFromRoots(roots: readonly Json[]): readonly ChatHistoryEntry[] {
  const messages = roots
    .map((root) => decodePublicProjectionRoot(root))
    .filter(
      (root): root is Extract<PublicProjectionRoot, { kind: "message" }> => root.kind === "message",
    )
    // Sort only this newly created array; the package targets ES2022.
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort((left, right) => {
      const a = BigInt(left.position);
      const b = BigInt(right.position);
      return a === b ? 0 : a < b ? -1 : 1;
    })
    .map((root) => root.message);
  return agUiMessagesToChatHistoryEntries(messages);
}

export interface AuthoritativeCommandSnapshot {
  readonly messages: readonly ChatHistoryEntry[];
  readonly activities: readonly StreamEvent[];
}

export function* authoritativeCommandSnapshot(params: {
  conversationId: string;
  head: ConversationHead | null;
  command: ConversationCommand | undefined;
  submitted: readonly ChatHistoryEntry[];
  maxModelContextBytes: number;
}): Operation<AuthoritativeCommandSnapshot> {
  const store = yield* useConversationStore();
  let base: readonly ChatHistoryEntry[] = [];
  let activities: readonly StreamEvent[] = [];
  if (params.head?.checkpoint) {
    const checkpoint = yield* store.getCheckpoint(params.head.checkpoint);
    if (!checkpoint) {
      throw new CrankError(
        "conversation_checkpoint_missing",
        `Conversation ${params.conversationId} checkpoint is missing`,
      );
    }
    base = historyEntriesFromRoots(
      yield* readAllPublicRootsForModel(
        params.conversationId,
        checkpoint,
        params.maxModelContextBytes,
      ),
    );
    activities = [];
  }

  const snapshot = (messages: readonly ChatHistoryEntry[]): AuthoritativeCommandSnapshot => ({
    messages,
    activities,
  });
  const command = params.command;
  if (!command || command.type === "interrupt-turn" || command.type === "respond-to-elicit") {
    return snapshot(base);
  }
  if (command.type === "send-message") {
    const accepted = params.submitted.filter(
      (entry) =>
        entry.type === "message" && entry.id === command.messageId && entry.message.role === "user",
    );
    if (accepted.length !== 1) {
      throw new CrankError(
        "invalid_chat_request",
        `send-message must carry exactly one matching user message ${command.messageId}`,
      );
    }
    const existing = base.find((entry) => entry.id === accepted[0]!.id);
    if (existing) {
      if (stableTupleHash([existing]) !== stableTupleHash([accepted[0]!])) {
        throw new CrankError(
          "command_identity_conflict",
          `Message ${accepted[0]!.id} conflicts with authoritative history`,
        );
      }
      return snapshot(base);
    }
    return snapshot([...base, accepted[0]!]);
  }

  const targetId = command.targetMessageId;
  if (!targetId) {
    let lastAssistant = -1;
    for (let index = base.length - 1; index >= 0; index -= 1) {
      const entry = base[index]!;
      if (entry.type === "message" && entry.message.role === "assistant") {
        lastAssistant = index;
        break;
      }
    }
    return snapshot(lastAssistant < 0 ? base : base.slice(0, lastAssistant));
  }
  const targetIndex = base.findIndex((entry) => entry.id === targetId);
  if (targetIndex < 0 || base[targetIndex]?.type !== "message") {
    throw new CrankError("invalid_chat_request", `Regenerate target ${targetId} does not exist`);
  }
  const target = base[targetIndex];
  return snapshot(
    target.message.role === "user" ? base.slice(0, targetIndex + 1) : base.slice(0, targetIndex),
  );
}
