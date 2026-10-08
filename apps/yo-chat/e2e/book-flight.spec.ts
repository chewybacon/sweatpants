import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Live book_flight journey.
 *
 * This deliberately exercises the durable boundary rather than the component
 * implementation: a normal user request, two elicitation steps, a reload while
 * the second step is pending, and a second booking whose route is inferred
 * from the first booking's durable history.
 */
test.setTimeout(90_000);

const RESPONSE_TIMEOUT = 30_000;
const FIRST_ROUTE = { from: "New York", to: "Los Angeles" } as const;
const RETURN_ROUTE = { from: "Los Angeles", to: "New York" } as const;
const SEAT = "1E";
const BOOKING_RESPONSE = /booked|confirmed/i;

function toolCalls(page: Page): Locator {
  return page.getByTestId("tool-call-block");
}

function flightTool(page: Page, route: { from: string; to: string }): Locator {
  return toolCalls(page)
    .filter({ hasText: `Select a flight from ${route.from} to ${route.to}` })
    .last();
}

function bookingResponses(page: Page): Locator {
  return page.getByTestId("message-text").filter({ hasText: BOOKING_RESPONSE });
}

async function startThread(page: Page): Promise<void> {
  await page.goto("/chat/flight/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Flight Booking" })).toBeVisible();
  await page.getByTestId("thread-create").click();
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder("Type a message...")).toBeEnabled({ timeout: 10_000 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder("Type a message...");
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("message-user").filter({ hasText: text })).toBeVisible({
    timeout: 5_000,
  });
}

async function chooseFlight(page: Page, route: { from: string; to: string }): Promise<Locator> {
  const tool = flightTool(page, route);
  await expect(tool, `expected a flight picker for ${route.from} to ${route.to}`).toBeVisible({
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(tool.locator("button").filter({ hasText: /\$\d+/ })).toHaveCount(3);

  const flight = tool.locator("button").filter({ hasText: /\$\d+/ }).first();
  await expect(flight).toBeEnabled();
  await flight.click();

  await expect(tool.getByText(/Select your seat on/i)).toBeVisible({
    timeout: RESPONSE_TIMEOUT,
  });
  return tool;
}

async function chooseSeat(tool: Locator): Promise<void> {
  const seat = tool.getByTitle(`Seat ${SEAT}`);
  await expect(seat, `expected available seat ${SEAT}`).toBeVisible({
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(seat).toBeEnabled();
  await seat.click();

  const confirm = tool.getByRole("button", { name: `Confirm Seat ${SEAT}` });
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await confirm.click();
  await expect(confirm).toHaveCount(0, { timeout: 5_000 });
}

async function expectBookingResponse(
  page: Page,
  index: number,
  route: { from: string; to: string },
): Promise<void> {
  const response = bookingResponses(page).nth(index);
  await expect(response, `expected booking response ${index + 1}`).toBeVisible({
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(response).toContainText(
    new RegExp(`(?:booked|confirmed).*${route.from}.*${route.to}`, "is"),
  );
}

test("book_flight survives refresh and preserves an implied return journey", async ({ page }) => {
  await startThread(page);

  const firstPrompt = "I want to fly from New York to Los Angeles";
  await sendMessage(page, firstPrompt);
  await chooseFlight(page, FIRST_ROUTE);

  // The seat elicitation is durable. Reload before answering it; the pending
  // seat picker must be reconstructed from the journal, not client state.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("Waiting for your response")).toBeVisible({ timeout: 10_000 });
  const restoredFirstTool = flightTool(page, FIRST_ROUTE);
  await expect(restoredFirstTool.getByText(/Select your seat on/i)).toBeVisible({
    timeout: RESPONSE_TIMEOUT,
  });
  await chooseSeat(restoredFirstTool);
  await expectBookingResponse(page, 0, FIRST_ROUTE);

  const returnPrompt = "ok, now the return flight";
  await sendMessage(page, returnPrompt);
  const returnTool = await chooseFlight(page, RETURN_ROUTE);
  await chooseSeat(returnTool);
  await expectBookingResponse(page, 1, RETURN_ROUTE);

  // A final reload verifies the durable transcript, not merely the live DOM.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByTestId("message-user")).toHaveCount(2);
  await expect(page.getByTestId("message-user").nth(0)).toContainText(firstPrompt);
  await expect(page.getByTestId("message-user").nth(1)).toContainText(returnPrompt);

  await expect(toolCalls(page)).toHaveCount(2);
  await expect(toolCalls(page).nth(0)).toContainText(
    "Select a flight from New York to Los Angeles",
  );
  await expect(toolCalls(page).nth(0)).toContainText(/Select your seat on/i);
  await expect(toolCalls(page).nth(0)).toContainText(/responded/i);
  await expect(toolCalls(page).nth(1)).toContainText(
    "Select a flight from Los Angeles to New York",
  );
  await expect(toolCalls(page).nth(1)).toContainText(/Select your seat on/i);
  await expect(toolCalls(page).nth(1)).toContainText(/responded/i);

  await expect(bookingResponses(page)).toHaveCount(2);
  await expectBookingResponse(page, 0, FIRST_ROUTE);
  await expectBookingResponse(page, 1, RETURN_ROUTE);
  await expect(page.getByRole("button", { name: /Confirm Seat/ })).toHaveCount(0);
});
