import { describe, expect, it } from "vitest";
import { withTestScenario, type ChatSnapshot, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

type TimelinePart = {
  readonly kind: string;
  readonly key?: string;
  readonly state?: string;
  readonly text?: string;
  readonly name?: string;
  readonly parts?: readonly TimelinePart[];
};

type TimelineMessage = {
  readonly index: number;
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly parts: readonly TimelinePart[];
};

type TimelineElicit = {
  readonly messageIndex: number;
  readonly key: string;
  readonly state: string;
  readonly path: readonly number[];
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summarizePart(value: unknown): TimelinePart {
  const part = record(value);
  const type = typeof part["type"] === "string" ? part["type"] : "unknown";
  const children = Array.isArray(part["parts"])
    ? part["parts"].map(summarizePart)
    : type === "message"
      ? Array.isArray(record(part["message"])["parts"])
        ? (record(part["message"])["parts"] as unknown[]).map(summarizePart)
        : undefined
      : undefined;
  return {
    kind: type,
    ...(typeof part["key"] === "string" ? { key: part["key"] } : {}),
    ...(typeof part["state"] === "string" ? { state: part["state"] } : {}),
    ...(typeof part["text"] === "string" ? { text: part["text"] } : {}),
    ...(typeof part["name"] === "string" ? { name: part["name"] } : {}),
    ...(children !== undefined ? { parts: children } : {}),
  };
}

function timeline(snapshot: ChatSnapshot): readonly TimelineMessage[] {
  return snapshot.messages.map((message, index) => ({
    index,
    id: message.id,
    role: message.role,
    text: message.parts
      .flatMap((part) => (part.type === "text" || part.type === "reasoning" ? [part.text] : []))
      .join(""),
    parts: message.parts.map(summarizePart),
  }));
}

function findElicits(snapshot: ChatSnapshot): readonly TimelineElicit[] {
  const found: TimelineElicit[] = [];
  const visit = (parts: readonly TimelinePart[], messageIndex: number, path: number[]): void => {
    parts.forEach((part, index) => {
      const nextPath = [...path, index];
      if (part.kind === "elicit" && part.key !== undefined && part.state !== undefined) {
        found.push({ messageIndex, key: part.key, state: part.state, path: nextPath });
      }
      if (part.parts) {
        visit(part.parts, messageIndex, nextPath);
      }
    });
  };
  for (const message of timeline(snapshot)) {
    visit(message.parts, message.index, []);
  }
  return found;
}

function latestElicit(snapshot: ChatSnapshot, key: string): TimelineElicit {
  const match = [...findElicits(snapshot)].reverse().find((elicit) => elicit.key === key);
  if (!match) {
    throw new Error(`Missing elicitation ${key} in ${JSON.stringify(timeline(snapshot))}`);
  }
  return match;
}

function assertFirstTurnOrder(
  snapshot: ChatSnapshot,
  firstPrompt: string,
  finalFirst: string,
): void {
  const messages = timeline(snapshot);
  const firstUser = messages.find((message) => message.text.includes(firstPrompt));
  const finalFirstMessage = messages.find((message) => message.text.includes(finalFirst));
  expect(firstUser?.role).toBe("user");
  expect(finalFirstMessage?.role).toBe("assistant");
  expect(firstUser!.index).toBeLessThan(finalFirstMessage!.index);
}

function assertTurnOrder(
  snapshot: ChatSnapshot,
  firstPrompt: string,
  secondPrompt: string,
  finalFirst: string,
  requirePending = true,
): void {
  const messages = timeline(snapshot);
  const firstUser = messages.find((message) => message.text.includes(firstPrompt));
  const finalFirstMessage = messages.find((message) => message.text.includes(finalFirst));
  const secondUser = messages.find((message) => message.text.includes(secondPrompt));
  expect(firstUser?.role).toBe("user");
  expect(finalFirstMessage?.role).toBe("assistant");
  expect(secondUser?.role).toBe("user");
  expect(firstUser!.index).toBeLessThan(finalFirstMessage!.index);
  expect(finalFirstMessage!.index).toBeLessThan(secondUser!.index);
  if (requirePending) {
    const pending = [...findElicits(snapshot)]
      .reverse()
      .find((elicit) => elicit.state === "pending");
    expect(pending?.messageIndex).toBeGreaterThan(secondUser!.index);
  }
}

async function runDurableSelectionOrder(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({ initialToolChoice: "required" });
      const firstPrompt = "DURABLE_ORDER_TURN_1 Select an option.";
      const firstTurn = yield* conversation.send(firstPrompt);
      const initial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* initial.respond.toolCalls([
        {
          id: "durable-order-call-1",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "durable-order-1" },
        },
      ]);
      const firstSample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* firstSample.respond.text("DURABLE_ORDER_SAMPLE_1");
      const firstChoice = yield* firstTurn.elicit("chooseOption");
      const firstPending = yield* firstTurn.expectSnapshot((snapshot) =>
        findElicits(snapshot).some(
          (elicit) => elicit.key === "chooseOption" && elicit.state === "pending",
        ),
      );
      expect(latestElicit(firstPending, "chooseOption").state).toBe("pending");
      yield* firstChoice.accept({ selected: "durable-order-1-alpha" });
      const firstFinal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* firstFinal.respond.text("DURABLE_ORDER_TURN_1_COMPLETE");
      yield* firstTurn.settled();
      const durableReplayFrameMark = s.agui.frames().length;
      const durableReopened = yield* conversation.reopen();
      expect(s.agui.frames(durableReplayFrameMark).map((frame) => frame.event.type)).toContain(
        "ACTIVITY_SNAPSHOT",
      );
      const durableRefreshed = durableReopened.snapshot();
      assertFirstTurnOrder(durableRefreshed, firstPrompt, "DURABLE_ORDER_TURN_1_COMPLETE");
      expect(latestElicit(durableRefreshed, "chooseOption").state).toBe("responded");

      const secondPrompt = "DURABLE_ORDER_TURN_2 Select another option.";
      const secondTurn = yield* durableReopened.send(secondPrompt);
      const secondInitial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* secondInitial.respond.toolCalls([
        {
          id: "durable-order-call-2",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "durable-order-2" },
        },
      ]);
      const secondSample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* secondSample.respond.text("DURABLE_ORDER_SAMPLE_2");
      const secondChoice = yield* secondTurn.elicit("chooseOption");
      const secondPending = yield* secondTurn.expectSnapshot((snapshot) => {
        const current = latestElicit(snapshot, "chooseOption");
        const previous = latestElicit(firstPending, "chooseOption");
        return current.state === "pending" && current.messageIndex > previous.messageIndex;
      });
      assertTurnOrder(secondPending, firstPrompt, secondPrompt, "DURABLE_ORDER_TURN_1_COMPLETE");
      expect(latestElicit(secondPending, "chooseOption").state).toBe("pending");
      yield* secondChoice.accept({ selected: "durable-order-2-beta" });
      const secondFinal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* secondFinal.respond.text("DURABLE_ORDER_TURN_2_COMPLETE");
      yield* secondTurn.settled();

      const complete = yield* secondTurn.snapshot();
      assertTurnOrder(complete, firstPrompt, secondPrompt, "DURABLE_ORDER_TURN_1_COMPLETE", false);
      expect(latestElicit(complete, "chooseOption").state).toBe("responded");
    },
  );
}

async function runOrdinaryBookingOrder(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({ initialToolChoice: "required" });
      const firstPrompt = "ORDER_TURN_1 Book NYC to LAX.";
      const firstTurn = yield* conversation.send(firstPrompt);
      const initial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* initial.respond.toolCalls([
        {
          id: "order-call-1",
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);

      const flight = yield* firstTurn.elicit("pickFlight");
      yield* flight.accept({ flightId: "FL001" });
      const seat = yield* firstTurn.elicit("pickSeat");
      const afterFlight = yield* firstTurn.expectSnapshot((snapshot) => {
        const elicits = findElicits(snapshot);
        return (
          elicits.some((elicit) => elicit.key === "pickFlight" && elicit.state === "responded") &&
          elicits.some((elicit) => elicit.key === "pickSeat" && elicit.state === "pending")
        );
      });
      expect(latestElicit(afterFlight, "pickFlight").messageIndex).toBe(
        latestElicit(afterFlight, "pickSeat").messageIndex,
      );

      yield* seat.accept({ row: 1, seat: "A" });
      const nested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain("NESTED_SAMPLE_PROMPT_V1");
      });
      yield* nested.respond.text("ORDER_TURN_1_TRAVEL_TIP");
      const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* final.respond.text("ORDER_TURN_1_COMPLETE");
      const firstSettled = yield* firstTurn.settled();
      expect(firstSettled.text).toContain("ORDER_TURN_1_COMPLETE");

      const afterFirst = yield* firstTurn.snapshot();
      expect(latestElicit(afterFirst, "pickFlight").state).toBe("responded");
      expect(latestElicit(afterFirst, "pickSeat").state).toBe("responded");

      const replayFrameMark = s.agui.frames().length;
      const reopened = yield* conversation.reopen();
      const replayFrames = s.agui.frames(replayFrameMark);
      expect(replayFrames.map((frame) => frame.event.type)).toContain("ACTIVITY_SNAPSHOT");
      const refreshed = reopened.snapshot();
      assertFirstTurnOrder(refreshed, firstPrompt, "ORDER_TURN_1_COMPLETE");
      expect(latestElicit(refreshed, "pickFlight").state).toBe("responded");
      expect(latestElicit(refreshed, "pickSeat").state).toBe("responded");

      const secondPrompt = "ORDER_TURN_2 Book NYC to LAX again.";
      const secondTurn = yield* reopened.send(secondPrompt);
      const secondInitial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* secondInitial.respond.toolCalls([
        {
          id: "order-call-2",
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);
      const secondFlight = yield* secondTurn.elicit("pickFlight");
      const afterSecondPending = yield* secondTurn.expectSnapshot((snapshot) => {
        const current = latestElicit(snapshot, "pickFlight");
        return (
          current.state === "pending" &&
          current.messageIndex > latestElicit(afterFirst, "pickSeat").messageIndex
        );
      });
      assertTurnOrder(afterSecondPending, firstPrompt, secondPrompt, "ORDER_TURN_1_COMPLETE");
      expect(latestElicit(afterSecondPending, "pickFlight").state).toBe("pending");

      yield* secondFlight.accept({ flightId: "FL001" });
      const secondSeat = yield* secondTurn.elicit("pickSeat");
      yield* secondSeat.accept({ row: 2, seat: "B" });
      const secondNested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain("NESTED_SAMPLE_PROMPT_V1");
      });
      yield* secondNested.respond.text("ORDER_TURN_2_TRAVEL_TIP");
      const secondFinal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* secondFinal.respond.text("ORDER_TURN_2_COMPLETE");
      yield* secondTurn.settled();

      const complete = yield* secondTurn.snapshot();
      assertTurnOrder(complete, firstPrompt, secondPrompt, "ORDER_TURN_1_COMPLETE", false);
      expect(latestElicit(complete, "pickFlight").state).toBe("responded");
      expect(latestElicit(complete, "pickSeat").state).toBe("responded");
      const frames = s.agui.frames();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((frame) => frame.lsn !== undefined)).toBe(true);
      expect(frames.map((frame) => frame.event.type)).toContain("ACTIVITY_SNAPSHOT");
    },
  );
}

describe("generic multi-turn message timeline", () => {
  // The worker-backed ordinary tool is the deterministic foreign/remote
  // execution boundary; the HTTP case adds the remote transport boundary.
  it("preserves ordinary foreign-tool elicits and message order in-process", async () => {
    await runOrdinaryBookingOrder("in-process");
  }, 30_000);

  it("preserves ordinary foreign-tool elicits and message order over HTTP", async () => {
    await runOrdinaryBookingOrder("http");
  }, 30_000);

  it("preserves durable-tool elicits and message order in-process", async () => {
    await runDurableSelectionOrder("in-process");
  }, 30_000);

  it("preserves durable-tool elicits and message order over HTTP", async () => {
    await runDurableSelectionOrder("http");
  }, 30_000);
});
