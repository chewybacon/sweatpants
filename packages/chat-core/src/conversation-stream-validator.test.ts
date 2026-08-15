import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  type ConversationAuthorityFrame,
} from "./conversation-protocol.ts";
import { validateConversationSegment } from "./conversation-stream-validator.ts";
import {
  CONVERSATION_WINDOW_FRAME_TYPE,
  type ConversationWindowFrame,
} from "./conversation-window.ts";

const running: ConversationAuthorityFrame = {
  type: CONVERSATION_AUTHORITY_FRAME_TYPE,
  authority: {
    conversationId: "conversation-1",
    revision: "1",
    state: "running",
    activeLogicalTurnId: "turn-1",
    activeExecutionId: "execution-1",
    latestCompletedExecutionId: null,
  },
};

const parked: ConversationAuthorityFrame = {
  type: CONVERSATION_AUTHORITY_FRAME_TYPE,
  authority: {
    conversationId: "conversation-1",
    revision: "2",
    state: "parked",
    activeLogicalTurnId: "turn-1",
    activeExecutionId: "execution-1",
    latestCompletedExecutionId: null,
  },
};

const idle: ConversationAuthorityFrame = {
  type: CONVERSATION_AUTHORITY_FRAME_TYPE,
  authority: {
    conversationId: "conversation-1",
    revision: "2",
    state: "idle",
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: "execution-1",
  },
};

const window: ConversationWindowFrame = {
  type: CONVERSATION_WINDOW_FRAME_TYPE,
  conversationId: "conversation-1",
  lineageId: "lineage-1",
  basisRevision: "1",
  windowToken: "token",
  windowMode: "reset",
  archiveFrontierOrdinal: "0",
  nextPublicPosition: "0",
  hotRoots: [],
  sealedCatchupRoots: [],
  applicationState: {},
  olderHistoryCursor: null,
};

describe("ConversationSegmentValidator", () => {
  it("accepts the canonical admitted native segment", () => {
    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-1" },
        window,
        running,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "assistant-1",
          role: "assistant",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
        idle,
        {
          type: EventType.RUN_FINISHED,
          threadId: "conversation-1",
          runId: "run-1",
          result: undefined,
        },
      ]),
    ).not.toThrow();
  });

  it("accepts a parked segment only with the interrupt-aware AG-UI outcome", () => {
    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-parked" },
        window,
        running,
        parked,
        {
          type: EventType.RUN_FINISHED,
          threadId: "conversation-1",
          runId: "run-parked",
          outcome: { type: "interrupt", interrupts: [] },
        },
      ]),
    ).not.toThrow();
  });

  it("accepts hydration without a fabricated run", () => {
    expect(() => validateConversationSegment([window, idle])).not.toThrow();
  });

  it("accepts a first-and-final pre-admission rejection", () => {
    expect(() =>
      validateConversationSegment([
        idle,
        { type: EventType.RUN_ERROR, message: "rejected", code: "rejected" },
      ]),
    ).not.toThrow();
  });

  it("rejects snapshot-before-run, missing running authority, and post-terminal events", () => {
    expect(() =>
      validateConversationSegment([
        { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-1" },
      ]),
    ).toThrow(/before RUN_STARTED/);
    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-1" },
        window,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant-1", delta: "x" },
      ]),
    ).toThrow(/before running authority/);
    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-1" },
        window,
        running,
        idle,
        { type: EventType.RUN_FINISHED, threadId: "conversation-1", runId: "run-1" },
        { type: EventType.RAW, event: { after: "terminal" }, source: "test" },
      ]),
    ).toThrow(/follow/);
  });

  it("rejects missing synchronization, duplicate terminal authority, and mismatched parked outcomes", () => {
    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-no-sync" },
        running,
        idle,
        { type: EventType.RUN_FINISHED, threadId: "conversation-1", runId: "run-no-sync" },
      ]),
    ).toThrow(/requires window or snapshot/);

    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-duplicate" },
        window,
        running,
        idle,
        idle,
        { type: EventType.RUN_FINISHED, threadId: "conversation-1", runId: "run-duplicate" },
      ]),
    ).toThrow(/only one terminal authority/);

    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-parked-error" },
        window,
        running,
        parked,
        { type: EventType.RUN_ERROR, message: "wrong terminal" },
      ]),
    ).toThrow(/interrupt-aware RUN_FINISHED/);

    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-idle-interrupt" },
        window,
        running,
        idle,
        {
          type: EventType.RUN_FINISHED,
          threadId: "conversation-1",
          runId: "run-idle-interrupt",
          outcome: { type: "interrupt", interrupts: [] },
        },
      ]),
    ).toThrow(/requires parked authority/);
  });
});
