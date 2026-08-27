import { describe, expect, it } from "vitest";
import type { Json } from "@sweatpants/foundation";

import { toolFailureEnvelope } from "./program-driver-chat-projection-codecs.ts";
import { requiredPendingCorrelation } from "./program-driver-chat-correlation.ts";
import type { ChatJournalIndex, PendingElicit } from "./program-driver-chat-journal-index.ts";

function pending(context: Json | undefined): PendingElicit {
  return {
    type: "PullRequested",
    taskId: "task-1",
    turnId: "turn-1",
    actionIndex: 0,
    pullId: "pull-1",
    pullIndex: 0,
    descriptorDigest: "descriptor-digest",
    descriptor: {
      kind: "elicit",
      key: "choose",
      message: "Choose",
      context,
      response: {
        inputProjection: {},
        result: {},
      },
    },
  } as unknown as PendingElicit;
}

function emptyIndex(): ChatJournalIndex {
  return {
    pullRequests: new Map(),
    resolvedPullIds: new Set(),
    tasks: new Map(),
    toolStartBeforePull: new Map(),
    publicToolCallIds: new Set(),
    previousToolStarts: new Map(),
    unfinishedToolCalls: [],
    cancellationPartials: new Map(),
    modelMessageIds: new Map(),
  };
}

describe("chat projection boundary codecs", () => {
  it("requires a serialized application error instead of inventing one", () => {
    expect(() => toolFailureEnvelope({ status: "error", error: { code: "failed" } })).toThrow(
      /serialized application error/,
    );
    expect(
      toolFailureEnvelope({
        status: "error",
        error: { code: "foreign_tool_error", message: "Tool failed" },
      }),
    ).toEqual({
      status: "error",
      error: { code: "foreign_tool_error", message: "Tool failed" },
    });
  });

  it("requires authored tool correlation instead of using the pull identity", () => {
    expect(() => requiredPendingCorrelation(emptyIndex(), pending(undefined))).toThrow(
      /no authored tool correlation/,
    );
    expect(
      requiredPendingCorrelation(
        emptyIndex(),
        pending({ context: { callId: "call-1", toolName: "choose_tool" } }),
      ),
    ).toEqual({ callId: "call-1", toolName: "choose_tool" });
  });
});
