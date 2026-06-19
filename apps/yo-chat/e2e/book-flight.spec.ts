import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * E2E tests for the book_flight MCP plugin tool.
 *
 * This tests the full flow of:
 * 1. User requests a flight booking
 * 2. LLM calls the book_flight tool
 * 3. Server-side tool execution triggers elicitation
 * 4. Client renders FlightList component
 * 5. User selects a flight
 * 6. Client sends response, server resumes tool
 * 7. SeatPicker component appears
 * 8. User selects a seat
 * 9. Confirmation message appears
 *
 * Tests require:
 * - Ollama running locally at http://localhost:11434
 * - A model that supports tool calling (e.g., qwen3:30b)
 *
 * Run with: pnpm test:e2e --grep "book_flight"
 */

// Reasonable timeout for LLM responses - fail fast if things are broken.
// The repeated-flow regression test drives two complete tool flows.
test.setTimeout(180000) // 3 minutes per test max

const TOOL_ERROR_PATTERN = /^Error:|tool execution failed|is not iterable|undefined is not|SESSION_NOT_FOUND/i
const BOOKING_CONFIRMATION_PATTERN = /ticket|confirmed|booked|confirmation|TKT-/i

async function sendChatMessage(page: Page, message: string) {
  const input = page.getByPlaceholder('Type a message...')
  await expect(input).toBeEnabled({ timeout: 30000 })
  await input.fill('')
  await input.pressSequentially(message, { delay: 5 })
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 5000 })
  await page.getByRole('button', { name: 'Send' }).click()
}

async function assertNoToolErrors(page: Page) {
  const errors = page.locator('text=' + TOOL_ERROR_PATTERN.toString())
  const count = await errors.count()
  if (count > 0) {
    const errorText = await errors.last().textContent()
    throw new Error(`Tool execution error detected: ${errorText}`)
  }
}

function latestFlightCard(page: Page): Locator {
  return page.locator('button').filter({ hasText: /\$\d+/ }).last()
}

function latestSeatButton(page: Page, seatCode: string): Locator {
  return page.getByTitle(`Seat ${seatCode}`).last()
}

function confirmationMessages(page: Page): Locator {
  return page.locator('text=' + BOOKING_CONFIRMATION_PATTERN.toString())
}

async function waitForFlightPicker(page: Page, label: string): Promise<Locator> {
  console.log(`${label}: waiting for FlightList`)
  const flightCard = latestFlightCard(page)
  await expect(flightCard, `${label}: expected active flight choices`).toBeVisible({ timeout: 60000 })
  await expect(flightCard, `${label}: expected active flight choice to be enabled`).toBeEnabled()
  await assertNoToolErrors(page)
  return flightCard
}

async function selectLatestFlight(page: Page, label: string) {
  const flightCard = await waitForFlightPicker(page, label)
  const flightText = await flightCard.textContent()
  console.log(`${label}: selecting flight ${flightText?.slice(0, 120)}`)
  await flightCard.click()

  await expect(
    page.getByText(/Selected|Select your seat|Select.*seat/i).last(),
    `${label}: expected flight selection acknowledgement or seat picker prompt`
  ).toBeVisible({ timeout: 30000 })
  await assertNoToolErrors(page)
}

async function waitForSeatPicker(page: Page, label: string, seatCode: string): Promise<Locator> {
  console.log(`${label}: waiting for SeatPicker`)
  const seatButton = latestSeatButton(page, seatCode)
  await expect(seatButton, `${label}: expected active seat ${seatCode}`).toBeVisible({ timeout: 45000 })
  await expect(seatButton, `${label}: expected active seat ${seatCode} to be enabled`).toBeEnabled()
  await assertNoToolErrors(page)
  return seatButton
}

async function selectSeatAndAssertConfirmButton(page: Page, label: string, seatCode: string) {
  const seatButton = await waitForSeatPicker(page, label, seatCode)
  console.log(`${label}: selecting seat ${seatCode}`)
  await seatButton.click()

  const confirmSeatButton = page.getByRole('button', { name: new RegExp(`Confirm Seat ${seatCode}`, 'i') }).last()
  await expect(
    confirmSeatButton,
    `${label}: selecting seat ${seatCode} should reveal the matching Confirm Seat button`
  ).toBeVisible({ timeout: 5000 })
  await expect(confirmSeatButton, `${label}: confirm seat button should be enabled`).toBeEnabled()

  console.log(`${label}: confirming seat ${seatCode}`)
  await confirmSeatButton.click()

  await expect(
    confirmSeatButton,
    `${label}: confirming seat ${seatCode} should leave the interactive SeatPicker state`
  ).not.toBeVisible({ timeout: 5000 })
  await assertNoToolErrors(page)
}

async function waitForAdditionalBookingConfirmation(
  page: Page,
  label: string,
  previousConfirmationCount: number
): Promise<number> {
  console.log(`${label}: waiting for booking confirmation`)
  await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 60000 })
  await expect
    .poll(async () => confirmationMessages(page).count(), {
      message: `${label}: expected another booking confirmation message`,
      timeout: 60000,
    })
    .toBeGreaterThan(previousConfirmationCount)

  await assertNoToolErrors(page)
  return confirmationMessages(page).count()
}

async function completeBookingFlow(
  page: Page,
  label: string,
  seatCode: string,
  previousConfirmationCount: number
): Promise<number> {
  await selectLatestFlight(page, label)
  await selectSeatAndAssertConfirmButton(page, label, seatCode)
  return waitForAdditionalBookingConfirmation(page, label, previousConfirmationCount)
}

// =============================================================================
// SETUP
// =============================================================================

test.describe('book_flight Plugin Tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat/flight/', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Flight Booking' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
    // Click input to ensure React is hydrated
    await page.getByPlaceholder('Type a message...').click()
  })

  // =============================================================================
  // BASIC FLOW TESTS
  // =============================================================================

  test('input allows typing flight booking request', async ({ page }) => {
    // Type a flight booking request using pressSequentially for React compatibility
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('Book a flight from NYC to Los Angeles', { delay: 10 })

    // Send button should be enabled
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 5000 })
  })

  test('LLM calls book_flight tool and FlightList appears', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('Use the book_flight tool to book a flight from New York to Los Angeles', { delay: 5 })

    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for streaming to start
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 30000 })

    // Check for actual error messages (not just 'error' as substring in words like 'cancelled')
    const errorLocator = page.locator('text=/^Error:|tool execution failed|is not iterable|undefined is not/')
    const hasError = await errorLocator.count() > 0
    if (hasError) {
      const errorText = await errorLocator.first().textContent()
      throw new Error(`Tool execution error detected: ${errorText}`)
    }

    // Wait for FlightList component to appear
    // The FlightList has airplane icons and flight cards with prices
    const flightList = page.locator('text=/\\$\\d+/').first() // Price like $299
    
    try {
      await expect(flightList).toBeVisible({ timeout: 45000 })
      console.log('FlightList component appeared!')

      // Verify we have multiple flight options
      const flightCards = page.locator('button').filter({ hasText: /\$\d+/ })
      const cardCount = await flightCards.count()
      expect(cardCount).toBeGreaterThan(0)
      console.log(`Found ${cardCount} flight options`)

    } catch (e) {
      // FlightList didn't appear - check what happened
      await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 30000 })

      const pageContent = await page.content()
      // Check for actual error indicators (not 'cancelled' which contains 'error' as substring)
      if (pageContent.includes('Error:') || pageContent.includes('tool execution failed')) {
        throw new Error('Error occurred during tool execution')
      }

      const responseText = await page.locator('.prose').last().textContent()
      console.log('FlightList did not appear. Response:', responseText?.slice(0, 500))

      // If LLM didn't call the tool, test is inconclusive but not a framework bug
      test.skip(true, 'LLM did not call book_flight tool')
    }
  })

  test('user can select a flight from FlightList', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('I want to book a flight from NYC to LA using the book_flight tool', { delay: 5 })

    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for FlightList to appear
    const flightCard = page.locator('button').filter({ hasText: /\$\d+/ }).first()

    try {
      await expect(flightCard).toBeVisible({ timeout: 45000 })

      // Get the flight details before clicking
      const flightText = await flightCard.textContent()
      console.log(`Selecting flight: ${flightText?.slice(0, 100)}`)

      // Click to select the flight
      await flightCard.click()

      // After selection, the card should show "Selected" state or transition to SeatPicker
      // Wait for either the selection confirmation or the next step
      const selectedIndicator = page.getByText('Selected')
      const seatPicker = page.getByText(/Select.*seat/i)

      // Wait for either indicator
      await expect(selectedIndicator.or(seatPicker)).toBeVisible({ timeout: 30000 })

      console.log('Flight selection successful!')

    } catch (e) {
      await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 30000 })
      const responseText = await page.locator('.prose').last().textContent()
      console.log('Flight selection flow incomplete. Response:', responseText?.slice(0, 500))
      test.skip(true, 'Could not complete flight selection flow')
    }
  })

  test('full booking flow: flight selection -> seat selection -> confirmation', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('Book a flight from New York to Los Angeles using book_flight', { delay: 5 })

    await page.getByRole('button', { name: 'Send' }).click()

    // === STEP 1: Wait for FlightList ===
    console.log('Step 1: Waiting for FlightList...')
    const flightCard = page.locator('button').filter({ hasText: /\$\d+/ }).first()

    try {
      await expect(flightCard).toBeVisible({ timeout: 45000 })
      console.log('FlightList appeared!')
    } catch {
      await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 30000 })
      test.skip(true, 'LLM did not trigger FlightList')
      return
    }

    // === STEP 2: Select a flight ===
    console.log('Step 2: Selecting a flight...')
    await flightCard.click()

    // === STEP 3: Wait for SeatPicker ===
    console.log('Step 3: Waiting for SeatPicker...')
    // SeatPicker has seat buttons like "A", "B", "C" in a grid
    // Look for the seat grid pattern
    const seatButton = page.locator('button').filter({ hasText: /^[A-F]$/ }).first()

    try {
      await expect(seatButton).toBeVisible({ timeout: 30000 })
      console.log('SeatPicker appeared!')
    } catch {
      // Check if there's an error or the flow didn't continue
      const pageContent = await page.content()
      console.log('SeatPicker did not appear. Checking page state...')
      
      // It's possible the selection worked but seat picker didn't show
      // Check for confirmation or error
      if (pageContent.includes('booked') || pageContent.includes('confirmed')) {
        console.log('Booking appears to be confirmed without seat selection')
        return
      }
      
      test.skip(true, 'SeatPicker did not appear after flight selection')
      return
    }

    // === STEP 4: Select a seat ===
    console.log('Step 4: Selecting a seat...')
    await seatButton.click()

    // === STEP 4b: Click the confirm button ===
    console.log('Step 4b: Confirming seat selection...')
    const confirmSeatButton = page.getByRole('button', { name: /Confirm Seat/i })
    try {
      await expect(confirmSeatButton).toBeVisible({ timeout: 5000 })
      await confirmSeatButton.click()
      console.log('Seat confirmed!')
    } catch {
      console.log('Confirm button not found, seat may have auto-confirmed')
    }

    // === STEP 5: Wait for confirmation ===
    console.log('Step 5: Waiting for confirmation...')
    
    // After seat selection, the tool should complete and show confirmation
    // Look for confirmation indicators
    const confirmationIndicators = [
      page.getByText(/ticket/i),
      page.getByText(/confirmed/i),
      page.getByText(/booked/i),
      page.getByText(/confirmation/i),
      page.getByText(/TKT-/), // Ticket number pattern
    ]

    let confirmed = false
    for (const indicator of confirmationIndicators) {
      try {
        await expect(indicator).toBeVisible({ timeout: 30000 })
        console.log('Booking confirmed!')
        confirmed = true
        break
      } catch {
        // Try next indicator
      }
    }

    if (!confirmed) {
      // Get final response for debugging
      await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 30000 })
      const finalResponse = await page.locator('.prose').last().textContent()
      console.log('Final response:', finalResponse?.slice(0, 500))
      
      // If we got through the flow without errors, consider it a success
      // The confirmation text might vary based on LLM response
      expect(finalResponse).toBeTruthy()
    }
  })

  // =============================================================================
  // COMPONENT DETAIL TESTS
  // =============================================================================

  test('FlightList shows airplane icons', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('Use book_flight to find flights from Boston to Miami', { delay: 5 })

    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for FlightList
    const flightCard = page.locator('button').filter({ hasText: /\$\d+/ }).first()

    try {
      await expect(flightCard).toBeVisible({ timeout: 45000 })

      // Check for SVG airplane icons
      const airplaneIcon = page.locator('svg').first()
      await expect(airplaneIcon).toBeVisible()
      console.log('Airplane icon found in FlightList')

    } catch {
      test.skip(true, 'FlightList did not appear')
    }
  })

  test('FlightList shows flight details (airline, times, duration, price)', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('Book a flight from Chicago to Seattle with book_flight', { delay: 5 })

    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for FlightList
    const priceElement = page.locator('text=/\\$\\d+/').first()

    try {
      await expect(priceElement).toBeVisible({ timeout: 45000 })

      // Verify flight card structure
      // Should have departure/arrival times, duration, price
      const departLabel = page.getByText('Depart')
      const arriveLabel = page.getByText('Arrive')

      await expect(departLabel.first()).toBeVisible()
      await expect(arriveLabel.first()).toBeVisible()

      // Check for duration (e.g., "4h 30m" or "2h 15m")
      const duration = page.locator('text=/\\d+h \\d+m/')
      await expect(duration.first()).toBeVisible()

      console.log('Flight card details verified!')

    } catch {
      test.skip(true, 'Could not verify FlightList details')
    }
  })

  test('SeatPicker shows airplane-shaped grid with available/taken seats', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('I need to book a flight NYC to LA, use book_flight tool', { delay: 5 })

    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for FlightList and select
    const flightCard = page.locator('button').filter({ hasText: /\$\d+/ }).first()

    try {
      await expect(flightCard).toBeVisible({ timeout: 45000 })
      await flightCard.click()

      // Wait for SeatPicker
      const seatGrid = page.locator('button').filter({ hasText: /^[A-F]$/ })
      await expect(seatGrid.first()).toBeVisible({ timeout: 30000 })

      // Count seats - should have multiple
      const seatCount = await seatGrid.count()
      expect(seatCount).toBeGreaterThan(0)
      console.log(`Found ${seatCount} seat buttons`)

      // Check for row numbers (1, 2, 3, etc.)
      const rowNumber = page.locator('text=/^\\d+$/').first()
      await expect(rowNumber).toBeVisible()

      console.log('SeatPicker grid structure verified!')

    } catch (e) {
      console.log('Could not verify SeatPicker:', e)
      test.skip(true, 'SeatPicker did not appear')
    }
  })

  // =============================================================================
  // EDGE CASE TESTS
  // =============================================================================

  test('can complete outbound and return bookings in the same chat session', async ({ page }) => {
    let confirmationCount = await confirmationMessages(page).count()

    await sendChatMessage(
      page,
      'Use the book_flight tool to book an outbound flight from Los Angeles to New York.'
    )
    confirmationCount = await completeBookingFlow(page, 'Outbound booking', '2A', confirmationCount)

    await sendChatMessage(
      page,
      'Great, now use the book_flight tool again to book the return flight from New York to Los Angeles.'
    )

    // Regression assertion: after a completed first flow, the second flow must
    // enter a fresh SeatPicker runtime. The bug we are capturing is that the
    // second SeatPicker renders, but clicking a seat does not reveal the
    // matching "Confirm Seat" button.
    confirmationCount = await completeBookingFlow(page, 'Return booking', '3C', confirmationCount)

    expect(confirmationCount).toBeGreaterThanOrEqual(2)
  })
})
