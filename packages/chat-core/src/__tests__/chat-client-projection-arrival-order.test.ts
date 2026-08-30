/**
 * Arrival-order characterization of the derived-view projection fold.
 *
 * Children carry logical parent references (`ParentRef`), so arrival order no
 * longer determines attachment: every order in which the message exists before
 * its generic activity converges to the same tree. The formerly rejected class
 * ("authoritative child cannot move with provisional message") is gone — late
 * placement shadows the synthetic node and children re-resolve.
 *
 * One divergent class remains, deliberately: a generic activity arriving
 * before ANY message exists roots itself (the latest-message heuristic finds
 * nothing) and is silently dropped by the materializer. That is not a
 * data-structure defect — the event carries no message binding, so fixing it
 * requires the protocol to carry one.
 */
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  createChatProjection,
  foldAGUIEvent,
  foldAGUIEvents,
  materializeChatMessages,
  type ChatProjectionState,
} from "../client/chat-client-projection.ts";

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

const activityBeforeEverything = (order: readonly UnitName[]): boolean =>
  order.indexOf("activity") === 0;

const key = (order: readonly UnitName[]): string => order.join(",");

describe("arrival-order characterization of the derived projection fold", () => {
  it("partitions all 24 arrival orders into converged and silently divergent", () => {
    const reference = normalize(replay(["placement", "text", "tool", "activity"]));
    expect(reference).toEqual([[MESSAGE_ID, "activity:example.custom", "text:hello", "tool:c1"]]);

    const converged: string[] = [];
    const divergent: { order: string; tree: readonly (readonly string[])[] }[] = [];
    for (const order of ORDERINGS) {
      const tree = normalize(replay(order));
      if (JSON.stringify(tree) === JSON.stringify(reference)) {
        converged.push(key(order));
      } else {
        divergent.push({ order: key(order), tree });
      }
    }

    // Every order in which the message exists before the generic activity
    // converges — including the six the maintained fold used to reject.
    expect(converged.sort()).toEqual(
      ORDERINGS.filter((order) => !activityBeforeEverything(order))
        .map(key)
        .sort(),
    );
    expect(converged).toHaveLength(18);

    // Exactly the orders where the activity precedes every message-creating
    // event diverge: the activity becomes an invisible root.
    expect(divergent.map((entry) => entry.order).sort()).toEqual(
      ORDERINGS.filter(activityBeforeEverything).map(key).sort(),
    );
    expect(divergent).toHaveLength(6);
  });

  it("re-anchors an authoritative child that preceded its message placement", () => {
    expect(normalize(replay(["text", "activity", "placement"]))).toEqual(
      normalize(replay(["text", "placement", "activity"])),
    );
  });

  it("re-parents synthetic tool children on late placement", () => {
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

describe("batched folding", () => {
  it("agrees with per-event folding for every arrival order", () => {
    for (const order of ORDERINGS) {
      const events = order.flatMap((name) => UNITS[name] as AGUIEvent[]);
      const perEvent = events.reduce(foldAGUIEvent, createChatProjection());
      const batched = foldAGUIEvents(createChatProjection(), events);
      expect(normalize(batched)).toEqual(normalize(perEvent));
    }
  });

  it("resolves a placement that arrives mid-batch, after its children", () => {
    // The tool's parentNodeId is computed from a stale index during the batch;
    // the final derivation overwrites it from the logical parentRef.
    const events = [...UNITS.text, ...UNITS.tool, ...UNITS.placement] as AGUIEvent[];
    const batched = foldAGUIEvents(createChatProjection(), events);
    const node = batched.nodes.get("execution:c1");

    expect(node?.node.parentNodeId).toBe("activity-message:m1");
    expect(batched.attachedChildren.get("activity-message:m1")).toEqual(["execution:c1"]);
  });
});
