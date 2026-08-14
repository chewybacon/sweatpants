import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  type ConversationAuthority,
  type ConversationAuthorityFrame,
} from "@sweatpants/chat-core";
import type { ConversationHead } from "@sweatpants/history-store/contract";

/** Project the complete public authority value; storage placement remains private. */
export function conversationAuthority(
  conversationId: string,
  head: ConversationHead | null,
): ConversationAuthority {
  if (head === null) {
    return {
      conversationId,
      revision: null,
      state: "idle",
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId: null,
    };
  }

  if (head.state === "idle") {
    if (head.activeLogicalTurnId !== null || head.activeExecutionId !== null) {
      throw new Error(`Idle conversation ${conversationId} retains active identity`);
    }
    return {
      conversationId,
      revision: head.revision,
      state: "idle",
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId: head.latestCompletedExecutionId,
    };
  }

  if (head.state === "deleted") {
    if (head.activeLogicalTurnId !== null || head.activeExecutionId !== null) {
      throw new Error(`Deleted conversation ${conversationId} retains active identity`);
    }
    return {
      conversationId,
      revision: head.revision,
      state: "deleted",
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId: head.latestCompletedExecutionId,
    };
  }

  if (head.activeLogicalTurnId === null || head.activeExecutionId === null) {
    throw new Error(`Active conversation ${conversationId} is missing active identity`);
  }
  return {
    conversationId,
    revision: head.revision,
    state: head.state,
    activeLogicalTurnId: head.activeLogicalTurnId,
    activeExecutionId: head.activeExecutionId,
    latestCompletedExecutionId: head.latestCompletedExecutionId,
  };
}

export function conversationAuthorityFrame(
  conversationId: string,
  head: ConversationHead | null,
): ConversationAuthorityFrame {
  return {
    type: CONVERSATION_AUTHORITY_FRAME_TYPE,
    authority: conversationAuthority(conversationId, head),
  };
}
