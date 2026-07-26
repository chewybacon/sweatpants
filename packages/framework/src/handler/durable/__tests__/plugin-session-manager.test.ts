import { resource, type Operation, type Stream } from "effection";

import type {
  ToolSession,
  ToolSessionEvent,
  ToolSessionRegistry,
} from "../../../lib/chat/mcp-tools/session/types.ts";
import { createPluginSessionManager } from "../plugin-session-manager.ts";
import { describe, expect, it } from "./vitest-effection.ts";

function eventStream(event: ToolSessionEvent): Stream<ToolSessionEvent, void> {
  return resource(function* (provide) {
    let sent = false;
    yield* provide({
      *next(): Operation<IteratorResult<ToolSessionEvent, void>> {
        if (sent) {
          return { done: true, value: undefined };
        }
        sent = true;
        return { done: false, value: event };
      },
    });
  });
}

describe("plugin session manager", () => {
  it("preserves elicitation context from the tool session", function* () {
    const toolSession: ToolSession = {
      id: "call-1",
      toolName: "play_ttt",
      *status() {
        return "awaiting_elicit" as const;
      },
      events() {
        return eventStream({
          type: "elicit_request",
          lsn: 1,
          timestamp: 1,
          elicitId: "pick-move-1",
          key: "pickMove",
          message: "Choose a move",
          schema: { type: "object" },
          context: { board: ["X", null, "O"], player: "X" },
        });
      },
      *respondToElicit() {},
      *respondToSample() {},
      *emitWakeUp() {},
      *cancel() {},
    };
    const registry = {
      *create() {
        return toolSession;
      },
      *get() {
        return toolSession;
      },
      *acquire() {
        return toolSession;
      },
      *release() {},
    } as unknown as ToolSessionRegistry;

    const manager = yield* createPluginSessionManager({ registry });
    const session = yield* manager.create({
      tool: { name: "play_ttt" } as never,
      params: {},
      callId: "call-1",
    });

    expect(yield* session.nextEvent()).toEqual({
      type: "elicit_request",
      elicitId: "pick-move-1",
      key: "pickMove",
      message: "Choose a move",
      schema: { type: "object" },
      context: { board: ["X", null, "O"], player: "X" },
    });
  });
});
