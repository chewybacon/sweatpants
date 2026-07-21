import { test, expect } from "@playwright/test";

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

test("canonical AG-UI interrupt renders plugin UI without LLM/provider involvement", async ({
  page,
}) => {
  const seenRequests: unknown[] = [];

  await page.route("**/api/chat", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      return route.continue();
    }

    const postData = request.postData();
    const parsed = postData ? JSON.parse(postData) : {};
    seenRequests.push(parsed);

    const hasResume = Array.isArray(parsed.resume) && parsed.resume.length > 0;

    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson(
        hasResume
          ? [
              {
                type: "ACTIVITY_SNAPSHOT",
                messageId: "sweatpants:plugin-replay:call-book-flight-1",
                activityType: "sweatpants:plugin-replay",
                replace: true,
                content: {
                  version: 1,
                  toolCallId: "call-book-flight-1",
                  toolName: "book_flight",
                  trace:
                    parsed.forwardedProps.sweatpants.clientReplayTraces["elicit-pick-flight-1"],
                },
              },
              {
                type: "TOOL_CALL_RESULT",
                messageId: "tool:call-book-flight-1",
                toolCallId: "call-book-flight-1",
                toolCallName: "book_flight",
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
              {
                type: "RUN_STARTED",
                threadId: "thread-1",
                runId: "run-1",
              },
              {
                type: "TOOL_CALL_START",
                toolCallId: "call-book-flight-1",
                toolCallName: "book_flight",
                parentMessageId: "assistant:tools:call-book-flight-1",
              },
              {
                type: "TOOL_CALL_ARGS",
                toolCallId: "call-book-flight-1",
                delta: JSON.stringify({ from: "NYC", destination: "LAX" }),
              },
              {
                type: "TOOL_CALL_END",
                toolCallId: "call-book-flight-1",
              },
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
                      responseSchema: {
                        type: "object",
                        properties: {
                          flightId: { type: "string" },
                        },
                        required: ["flightId"],
                        "x-elicit-context": { flights },
                      },
                      metadata: {
                        "sweatpants/sessionId": "session-book-flight-1",
                        "sweatpants/toolName": "book_flight",
                        "sweatpants/key": "pickFlight",
                        "sweatpants/componentMode": "plugin-render",
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
  await expect(page.getByText("Pipeline ready")).toBeVisible({ timeout: 10000 });

  await page.getByPlaceholder("Type a message...").fill("book a flight");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => seenRequests.length, { timeout: 5000 }).toBe(1);
  expect(seenRequests[0]).toMatchObject({
    enabledPlugins: ["book_flight"],
  });

  const firstFlight = page.locator("button").filter({ hasText: /\$299/ }).first();
  await expect(
    firstFlight,
    "the browser-side plugin runtime should render FlightList for the canonical AG-UI interrupt",
  ).toBeVisible({ timeout: 5000 });

  await firstFlight.click();

  await expect.poll(() => seenRequests.length, { timeout: 5000 }).toBe(2);
  expect(seenRequests[1]).toMatchObject({
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
    forwardedProps: {
      sweatpants: {
        clientReplayTraces: {
          "elicit-pick-flight-1": {
            emissions: [
              {
                componentKey: "FlightList",
                response: { flightId: "FL001" },
                emissionId: "elicit-pick-flight-1-em-1",
                sourceInterruptId: "elicit-pick-flight-1",
              },
            ],
          },
        },
      },
    },
  });

  await expect(page.getByText(/Selected: SkyHigh Airways SH 142/)).toBeVisible({ timeout: 5000 });
});
