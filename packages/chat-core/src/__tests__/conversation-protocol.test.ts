import { describe, expect, it } from "vitest";
import {
  advanceConversationAuthority,
  compareAuthorityRevisions,
  decodeConversationAuthority,
} from "../client/conversation-protocol.ts";

describe("conversation authority protocol", () => {
  it("parses one complete active authority value", () => {
    expect(
      decodeConversationAuthority({
        conversationId: "conversation-1",
        revision: "18446744073709551615",
        state: "parked",
        activeLogicalTurnId: "turn-1",
        activeExecutionId: "execution-1",
        latestCompletedExecutionId: null,
      }),
    ).toEqual({
      conversationId: "conversation-1",
      revision: "18446744073709551615",
      state: "parked",
      activeLogicalTurnId: "turn-1",
      activeExecutionId: "execution-1",
      latestCompletedExecutionId: null,
    });
  });

  it("rejects an idle value that retains active identity", () => {
    expect(() =>
      decodeConversationAuthority({
        conversationId: "conversation-1",
        revision: "2",
        state: "idle",
        activeLogicalTurnId: "turn-1",
        activeExecutionId: "execution-1",
        latestCompletedExecutionId: null,
      }),
    ).toThrow(/must not identify an active Turn/);
  });

  it("folds authority monotonically and rejects conflicting equal revisions", () => {
    const idle = decodeConversationAuthority({
      conversationId: "conversation-1",
      revision: "4",
      state: "idle",
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId: "execution-3",
    });
    const stale = decodeConversationAuthority({
      conversationId: "conversation-1",
      revision: "3",
      state: "idle",
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId: "execution-2",
    });
    expect(advanceConversationAuthority(idle, stale, "conversation-1")).toBe(idle);
    expect(() =>
      advanceConversationAuthority(
        idle,
        { ...idle, latestCompletedExecutionId: "conflict" },
        "conversation-1",
      ),
    ).toThrow(/conflicting content/);
  });

  it("orders canonical 64-bit decimal revisions without number coercion", () => {
    expect(compareAuthorityRevisions(null, "0")).toBe(-1);
    expect(compareAuthorityRevisions("10", "9")).toBe(1);
    expect(compareAuthorityRevisions("18446744073709551615", "18446744073709551614")).toBe(1);
    expect(compareAuthorityRevisions("42", "42")).toBe(0);
    expect(() => compareAuthorityRevisions("01", "1")).toThrow(/canonical/);
    expect(() => compareAuthorityRevisions("18446744073709551616", "1")).toThrow(/64-bit/);
  });
});
