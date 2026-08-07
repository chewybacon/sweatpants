import { test, expect } from "@playwright/test";
import { bookFlightPlugin } from "../src/tools/book-flight/plugin";

const pickFlightBinding = [...bookFlightPlugin.client.bindings.values()].find(
  (binding) => binding.key === "pickFlight",
)!;

const flights = [
  {
    id: "FL001",
    airline: "SkyHigh Airways",
    flightNumber: "SH 142",
    departure: "08:00",
    arrival: "11:30",
    duration: "3h 30m",
    price: 299,
  },
  {
    id: "FL002",
    airline: "CloudAir",
    flightNumber: "CA 287",
    departure: "12:45",
    arrival: "16:00",
    duration: "3h 15m",
    price: 349,
  },
];

function ndjson(events: unknown[]): string {
  return events.map((event, index) => JSON.stringify({ lsn: index + 1, event })).join("\n") + "\n";
}

function activity(messageId: string, node: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "ACTIVITY_SNAPSHOT",
    messageId,
    activityType: "sweatpants:public-execution",
    replace: true,
    content: { version: 1, node },
  };
}

test("canonical AG-UI interrupt renders plugin UI without LLM/provider involvement", async ({
  page,
}) => {
  const seenRequests: unknown[] = [];
  const messageRecord = "activity:message:book-flight-1";
  const toolRecord = "activity:tool:book-flight-1";
  const nestedMessageRecord = "activity:message:nested-flight-guidance-1";
  const elicitRecord = "activity:elicit:pick-flight-1";

  await page.route("**/api/chat", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      return route.continue();
    }

    const postData = request.postData();
    const parsed = postData ? JSON.parse(postData) : {};
    seenRequests.push(parsed);
    const hasResume =
      typeof parsed.input === "object" &&
      parsed.input !== null &&
      Array.isArray(parsed.input.resume) &&
      parsed.input.resume.length > 0;

    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson(
        hasResume
          ? [
              {
                type: "ACTIVITY_DELTA",
                messageId: elicitRecord,
                activityType: "sweatpants:public-execution",
                patch: [{ op: "replace", path: "/node/state", value: "responded" }],
              },
              {
                type: "ACTIVITY_DELTA",
                messageId: toolRecord,
                activityType: "sweatpants:public-execution",
                patch: [
                  { op: "replace", path: "/node/state", value: "output-available" },
                  {
                    op: "add",
                    path: "/node/publicData/output",
                    value: { success: true, message: "Selected FL001" },
                  },
                ],
              },
              {
                type: "TOOL_CALL_RESULT",
                messageId: "tool:call-book-flight-1",
                toolCallId: "call-book-flight-1",
                content: JSON.stringify({ success: true, message: "Selected FL001" }),
                role: "tool",
              },
              {
                type: "RUN_FINISHED",
                threadId: "thread-1",
                runId: "run-2",
                outcome: { type: "success" },
              },
            ]
          : [
              { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" },
              {
                type: "TOOL_CALL_START",
                toolCallId: "call-book-flight-1",
                toolCallName: "book_flight",
                parentMessageId: "message:book-flight-1",
              },
              {
                type: "TOOL_CALL_ARGS",
                toolCallId: "call-book-flight-1",
                delta: JSON.stringify({ from: "NYC", destination: "LAX" }),
              },
              { type: "TOOL_CALL_END", toolCallId: "call-book-flight-1" },
              activity(messageRecord, {
                nodeId: "message:book-flight-1",
                parentNodeId: null,
                sequence: 0,
                kind: "message",
                state: "streaming",
                presentation: "public",
                publicData: {
                  kind: "message",
                  messageId: "message:book-flight-1",
                  role: "assistant",
                },
              }),
              activity(toolRecord, {
                nodeId: "execution:call-book-flight-1",
                parentNodeId: "message:book-flight-1",
                sequence: 0,
                kind: "tool-call",
                state: "input-available",
                presentation: "public",
                publicData: {
                  kind: "tool-call",
                  callId: "call-book-flight-1",
                  name: "book_flight",
                  rawInput: JSON.stringify({ from: "NYC", destination: "LAX" }),
                  input: { from: "NYC", destination: "LAX" },
                },
              }),
              {
                type: "TEXT_MESSAGE_START",
                messageId: "message:nested-flight-guidance-1",
                role: "assistant",
              },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "message:nested-flight-guidance-1",
                delta: "Nested flight guidance.",
              },
              {
                type: "TEXT_MESSAGE_END",
                messageId: "message:nested-flight-guidance-1",
              },
              activity(nestedMessageRecord, {
                nodeId: "message:nested-flight-guidance-1",
                parentNodeId: "execution:call-book-flight-1",
                sequence: 1,
                kind: "message",
                state: "done",
                presentation: "public",
                publicData: {
                  kind: "message",
                  messageId: "message:nested-flight-guidance-1",
                  role: "assistant",
                },
              }),
              activity(elicitRecord, {
                nodeId: "elicit:elicit-pick-flight-1",
                parentNodeId: "execution:call-book-flight-1",
                sequence: 0,
                kind: "elicit",
                state: "pending",
                presentation: "public",
                publicData: {
                  kind: "elicit",
                  elicitId: "elicit-pick-flight-1",
                  bindingId: pickFlightBinding.bindingId,
                  key: "pickFlight",
                  message: "Select a flight from NYC to LAX",
                  context: { flights },
                  responseContract: pickFlightBinding.responseContract,
                  ...(pickFlightBinding.contextContract
                    ? { contextContract: pickFlightBinding.contextContract }
                    : {}),
                  toolName: "book_flight",
                  callId: "call-book-flight-1",
                  producerSequence: 0,
                },
              }),
              {
                type: "RUN_FINISHED",
                threadId: "thread-1",
                runId: "run-1",
                outcome: {
                  type: "interrupt",
                  interrupts: [
                    {
                      id: "elicit-pick-flight-1",
                      reason: "input_required",
                      message: "Select a flight from NYC to LAX",
                      toolCallId: "call-book-flight-1",
                      responseSchema: pickFlightBinding.responseContract.inputProjection,
                      metadata: {
                        "sweatpants/toolName": "book_flight",
                        "sweatpants/key": "pickFlight",
                      },
                    },
                  ],
                },
              },
            ],
      ),
    });
  });

  await page.goto("/chat/flight/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Flight Booking" })).toBeVisible();
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("thread-create").click();
  await expect(page.getByPlaceholder("Type a message...")).toBeEnabled({ timeout: 10000 });

  await page.getByPlaceholder("Type a message...").fill("book a flight");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled({ timeout: 5000 });
  await send.click({ timeout: 5000 });

  await expect.poll(() => seenRequests.length, { timeout: 5000 }).toBe(1);
  expect(seenRequests[0]).not.toHaveProperty("enabledPlugins");

  const firstFlight = page.locator("button").filter({ hasText: /\$299/ }).first();
  await expect(
    firstFlight,
    "the browser-side plugin runtime should render FlightList for the canonical AG-UI interrupt",
  ).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("Nested flight guidance.")).toBeVisible();

  await firstFlight.click();

  await expect.poll(() => seenRequests.length, { timeout: 5000 }).toBe(2);
  expect(seenRequests[1]).toMatchObject({
    input: {
      resume: [
        {
          interruptId: "elicit-pick-flight-1",
          status: "resolved",
          payload: {
            action: "accept",
            content: { flightId: "FL001" },
          },
        },
      ],
    },
  });
  expect(seenRequests[1]).not.toHaveProperty("enabledPlugins");

  await expect(page.getByText(/Selected FL001/)).toBeVisible({ timeout: 5000 });
});
