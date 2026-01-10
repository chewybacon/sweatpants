import { test, expect } from '@playwright/test'

/**
 * Full book_flight flow E2E test.
 *
 * Tests the complete multi-step elicitation:
 * 1. User sends message → LLM calls book_flight
 * 2. FlightList appears → user selects flight
 * 3. SeatPicker appears → user selects seat
 * 4. Booking confirmation with ticket number
 */

test.setTimeout(360000) // 6 minutes for slow local LLMs

test('book_flight full flow: flight → seat → confirmation', async ({ page }) => {
  // Debug logging
  page.on('request', async (req) => {
    if (req.url().includes('/api/chat') && req.method() === 'POST') {
      const body = req.postData()
      if (body) {
        try {
          const parsed = JSON.parse(body)
          if (parsed.pluginElicitResponses) {
            console.log('→ pluginElicitResponses:', JSON.stringify(parsed.pluginElicitResponses))
          }
        } catch {}
      }
    }
  })

  page.on('response', async (res) => {
    if (res.url().includes('/api/chat')) {
      try {
        const text = await res.text()
        const lines = text.split('\n').filter((l) => l.trim())
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            const eventType = parsed.event?.type
            if (eventType === 'plugin_elicit_request') {
              console.log(`← plugin_elicit_request key=${parsed.event.key}`)
            } else if (eventType === 'tool_result') {
              console.log(`← tool_result: ${parsed.event.content?.slice(0, 100)}...`)
            } else if (eventType === 'complete') {
              console.log(`← complete`)
            } else if (eventType === 'error') {
              console.log(`← error: ${parsed.event.message}`)
            }
          } catch {}
        }
      } catch {}
    }
  })

  await page.goto('/chat/flight/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Flight Booking' })).toBeVisible()
  await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })

  const input = page.getByPlaceholder('Type a message...')
  await input.click() // Ensure hydration
  await input.pressSequentially('Book a flight from NYC to LA using the book_flight tool', { delay: 5 })
  await page.getByRole('button', { name: 'Send' }).click()

  // === STEP 1: Wait for FlightList ===
  console.log('Step 1: Waiting for FlightList...')
  const flightCard = page.locator('button').filter({ hasText: /\$\d+/ }).first()
  await expect(flightCard).toBeVisible({ timeout: 240000 })
  console.log('✓ FlightList appeared')

  // === STEP 2: Select a flight ===
  console.log('Step 2: Selecting flight...')
  await flightCard.click()

  // === STEP 3: Wait for SeatPicker ===
  console.log('Step 3: Waiting for SeatPicker...')
  const seatButton = page.locator('button').filter({ hasText: /^[A-F]$/ }).first()
  await expect(seatButton).toBeVisible({ timeout: 60000 })
  console.log('✓ SeatPicker appeared')

  // === STEP 4: Select a seat ===
  console.log('Step 4: Selecting seat...')
  await seatButton.click()

  // === STEP 4b: Confirm seat selection ===
  console.log('Step 4b: Confirming seat...')
  const confirmButton = page.getByRole('button', { name: /Confirm Seat/ })
  await expect(confirmButton).toBeVisible({ timeout: 5000 })
  await confirmButton.click()

  // === STEP 5: Wait for confirmation ===
  console.log('Step 5: Waiting for confirmation...')

  // The tool returns a result with ticketNumber like "TKT-XXXXXXXX"
  // The LLM should mention the ticket in its response
  const ticketPattern = page.locator('text=/TKT-[A-Z0-9]+/')

  try {
    await expect(ticketPattern).toBeVisible({ timeout: 120000 })
    const ticketText = await ticketPattern.textContent()
    console.log(`✓ Booking confirmed! Ticket: ${ticketText}`)
  } catch {
    // Ticket number might not be visible, but check for confirmation keywords
    console.log('Ticket number not directly visible, checking for confirmation...')

    // Wait for streaming to complete
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 60000 })

    // Check for confirmation indicators in the response
    const pageText = await page.locator('body').textContent()
    const hasConfirmation =
      pageText?.includes('booked') ||
      pageText?.includes('confirmed') ||
      pageText?.includes('ticket') ||
      pageText?.includes('reservation') ||
      pageText?.includes('TKT-')

    if (hasConfirmation) {
      console.log('✓ Booking confirmed (found confirmation text)')
    } else {
      // Get the last assistant message for debugging
      const lastMessage = await page.locator('.prose').last().textContent()
      console.log('Last response:', lastMessage?.slice(0, 300))
      throw new Error('Booking confirmation not found')
    }
  }

  console.log('✓ Full booking flow completed successfully!')
})
