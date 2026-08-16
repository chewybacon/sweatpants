/**
 * Arrival-order characterization of the maintained projection fold.
 *
 * Documents, before the derived-view refactor, exactly how `foldAGUIEvent`
 * behaves for every arrival order of one message's placement, content, and
 * children. The styles experiment (`foundation/src/styles/derived-view-style`)
 * predicts three classes; this pins production to them:
 *
 *   - converged: placement precedes the generic activity.
 *   - rejected:  a synthetic message exists when the generic activity arrives,
 *     so late placement hits "authoritative child cannot move".
 *   - divergent: the generic activity arrives before any message exists; the
 *     latest-message heuristic finds nothing, the activity becomes a root, and
 *     the materializer silently drops it.
 *
 * The derived-view refactor is expected to move the rejected class into
 * converged (message-bound children re-resolve to the authoritative node).
 * The divergent class is NOT a data-structure defect: the generic activity
 * event carries no message binding, so which message it attaches to is decided
 * by an ingest-time heuristic. Fixing that class requires the event to carry
 * an explicit binding, which is a protocol decision.
 */
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  ChatProjectionError,
  createChatProjection,
  foldAGUIEvent,
  materializeChatMessages,
  type ChatProjectionState,
} from "./chat-client-projection.ts";

const MESSAGE_ID = "m1";

type UnitName = "text" | "tool" | "activity" | "placement";

const UNITS: Record<UnitName, readonly unknown[]> = {
  text: [
    { type: EventType.TEXT_MESSAGE_START, messageId: MESSAGE_ID, role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: MESSAGE_ID, delta: "hello" },
    { type: EventType.TEXT_MESSAGE_END, messageId: MESSAGE_ID },
  ],
  tool: [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "example",
      parentMessageId: MESSAGE_ID,
    },
  ],
  activity: [
    {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "r1",
      activityType: "example.custom",
      content: { value: 1 },
      replace: true,
    },
  ],
  placement: [
    {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-message:m1",
      activityType: "sweatpants:public-execution",
      content: {
        version: 1,
        node: {
          nodeId: "activity-message:m1",
          parentNodeId: null,
          sequence: 7,
          kind: "message",
          state: "done",
          presentation: "public",
          publicData: { kind: "message", messageId: MESSAGE_ID, role: "assistant" },
        },
      },
      replace: true,
    },
  ],
};

function replay(order: readonly UnitName[]): ChatProjectionState {
  let state = createChatProjection();
  for (const name of order) {
    for (const event of UNITS[name]) {
      state = foldAGUIEvent(state, event as AGUIEvent);
    }
  }
  return state;
}

/** Arrival-order-independent structural identity for one projection. */
function normalize(state: ChatProjectionState): readonly (readonly string[])[] {
  return materializeChatMessages(state, { allowPending: true }).map((message) => [
    message.id,
    ...[...message.parts]
      .map((part) =>
        part.type === "text"
          ? `text:${part.text}`
          : part.type === "tool-call"
            ? `tool:${part.callId}`
            : part.type === "activity"
              ? `activity:${part.activityType}`
              : part.type,
      )
      .sort(),
  ]);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

const ORDERINGS = permutations<UnitName>(["text", "tool", "activity", "placement"]);

const placementBeforeActivity = (order: readonly UnitName[]): boolean =>
  order.indexOf("placement") < order.indexOf("activity");
const activityBeforeEverything = (order: readonly UnitName[]): boolean =>
  order.indexOf("activity") === 0;
const activityUnderProvisional = (order: readonly UnitName[]): boolean =>
  !placementBeforeActivity(order) && !activityBeforeEverything(order);

const key = (order: readonly UnitName[]): string => order.join(",");

describe("arrival-order characterization of the maintained projection fold", () => {
  it("partitions all 24 arrival orders into converged, rejected, and silently divergent", () => {
    const reference = normalize(replay(["placement", "text", "tool", "activity"]));
    expect(reference).toEqual([[MESSAGE_ID, "activity:example.custom", "text:hello", "tool:c1"]]);

    const converged: string[] = [];
    const rejected: { order: string; error: unknown }[] = [];
    const divergent: { order: string; tree: readonly (readonly string[])[] }[] = [];
    for (const order of ORDERINGS) {
      let state: ChatProjectionState;
      try {
        state = replay(order);
      } catch (error) {
        rejected.push({ order: key(order), error });
        continue;
      }
      const tree = normalize(state);
      if (JSON.stringify(tree) === JSON.stringify(reference)) {
        converged.push(key(order));
      } else {
        divergent.push({ order: key(order), tree });
      }
    }

    // Exactly the orders where placement precedes the generic activity converge.
    expect(converged.sort()).toEqual(ORDERINGS.filter(placementBeforeActivity).map(key).sort());
    expect(converged).toHaveLength(12);

    // Exactly the orders where the activity lands under a provisional message
    // are rejected at placement time.
    expect(rejected.map((entry) => entry.order).sort()).toEqual(
      ORDERINGS.filter(activityUnderProvisional).map(key).sort(),
    );
    expect(rejected).toHaveLength(6);

    // Exactly the orders where the activity precedes every message-creating
    // event diverge: the activity becomes an invisible root.
    expect(divergent.map((entry) => entry.order).sort()).toEqual(
      ORDERINGS.filter(activityBeforeEverything).map(key).sort(),
    );
    expect(divergent).toHaveLength(6);
  });

  it("rejects late placement with chat_activity_conflict when an authoritative child arrived first", () => {
    const failing: readonly UnitName[] = ["text", "activity", "placement"];
    expect(() => replay(failing)).toThrow(ChatProjectionError);
    expect(() => replay(failing)).toThrow(/cannot move with provisional message/);
    try {
      replay(failing);
    } catch (error) {
      expect((error as ChatProjectionError).code).toBe("chat_activity_conflict");
    }
  });

  it("migrates synthetic tool children on late placement (what the surgery buys today)", () => {
    expect(normalize(replay(["text", "tool", "placement"]))).toEqual(
      normalize(replay(["placement", "text", "tool"])),
    );
  });

  it("silently drops a generic activity that arrived before any message", () => {
    const tree = normalize(replay(["activity", "text", "tool", "placement"]));
    // The activity is gone: it rooted itself before m1 existed, and root
    // activities are not reachable from the message materializer.
    expect(tree).toEqual([[MESSAGE_ID, "text:hello", "tool:c1"]]);
  });
});
