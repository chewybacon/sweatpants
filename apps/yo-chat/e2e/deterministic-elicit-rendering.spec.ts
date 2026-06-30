import { test, expect } from '@playwright/test'

const flights = [
  {
    id: 'FL001',
    airline: 'SkyHigh Airways',
    flightNumber: 'SH 142',
    departure: '08:00',
    arrival: '11:30',
    duration: '3h 30m',
    price: 299,
  },
  {
    id: 'FL002',
    airline: 'CloudAir',
    flightNumber: 'CA 287',
    departure: '12:45',
    arrival: '16:00',
    duration: '3h 15m',
    price: 349,
  },
]

function ndjson(events: unknown[]): string {
  return events
    .map((event, index) => JSON.stringify({ lsn: index + 1, event }))
    .join('\n') + '\n'
}

test('canonical elicit_request renders plugin UI without LLM/provider involvement', async ({ page }) => {
  const seenRequests: unknown[] = []

  await page.route('**/api/chat', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') {
      return route.continue()
    }

    const postData = request.postData()
    if (postData) {
      seenRequests.push(JSON.parse(postData))
    }

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      body: ndjson([
        {
          type: 'session_info',
          capabilities: {
            thinking: true,
            streaming: true,
            tools: ['book_flight'],
          },
          persona: null,
        },
        {
          type: 'ag_ui_tool_call_start',
          toolCallId: 'call-book-flight-1',
          toolCallName: 'book_flight',
          parentMessageId: 'assistant:tools:call-book-flight-1',
        },
        {
          type: 'ag_ui_tool_call_args',
          toolCallId: 'call-book-flight-1',
          delta: JSON.stringify({ from: 'NYC', destination: 'LAX' }),
        },
        {
          type: 'ag_ui_tool_call_end',
          toolCallId: 'call-book-flight-1',
        },
        {
          type: 'elicit_request',
          sessionId: 'session-book-flight-1',
          callId: 'call-book-flight-1',
          toolName: 'book_flight',
          elicitId: 'elicit-pick-flight-1',
          key: 'pickFlight',
          message: 'Select a flight from NYC to LAX',
          schema: {
            type: 'object',
            properties: {
              flightId: { type: 'string' },
            },
            required: ['flightId'],
            'x-model-context': { flights },
          },
        },
      ]),
    })
  })

  await page.goto('/chat/flight/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Flight Booking' })).toBeVisible()
  await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })

  await page.getByPlaceholder('Type a message...').fill('book a flight')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect.poll(() => seenRequests.length, { timeout: 5000 }).toBe(1)
  expect(seenRequests[0]).toMatchObject({
    enabledPlugins: ['book_flight'],
  })

  await expect(
    page.locator('button').filter({ hasText: /\$299/ }).first(),
    'the browser-side plugin runtime should render FlightList for the canonical elicit_request',
  ).toBeVisible({ timeout: 5000 })
})
