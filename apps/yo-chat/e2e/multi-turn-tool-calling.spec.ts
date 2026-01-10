import { test, expect } from '@playwright/test'

/**
 * E2E tests for multi-turn tool calling.
 * 
 * These tests verify that when a tool (like pick_card) is used,
 * subsequent requests properly include the tool call history
 * so the LLM can call tools again.
 * 
 * The bug we're testing for: After first tool call completes,
 * the history wasn't being updated with tool_calls and tool results,
 * causing the LLM to not call tools on subsequent turns.
 */

test.describe('multi-turn tool calling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat/cards/', { waitUntil: 'networkidle' })
    // Wait for pipeline to be ready
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 15000 })
    // Click input to ensure React is hydrated
    await page.getByPlaceholder('Type a message...').click()
  })

  test('should call pick_card tool and show card picker', async ({ page }) => {
    // Type and send message to draw cards
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('draw 3 cards', { delay: 10 })
    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for card picker to appear (cards are rendered as buttons)
    // The CardPicker component renders card buttons
    const cardButton = page.locator('button').filter({ hasText: /[AKQJ2-9]|10/ }).first()
    await expect(cardButton).toBeVisible({ timeout: 30000 })
  })

  test('should complete tool flow when card is picked', async ({ page }) => {
    // Send message to draw cards
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('draw 3 cards', { delay: 10 })
    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for card picker
    const cardButtons = page.locator('button').filter({ hasText: /[♠♥♦♣]/ })
    await expect(cardButtons.first()).toBeVisible({ timeout: 30000 })

    // Pick a card
    await cardButtons.first().click()

    // Wait for assistant response acknowledging the pick
    // The LLM should respond with something about the selection
    await expect(page.getByText(/selected|picked|choice|chose/i)).toBeVisible({ timeout: 30000 })
  })

  test('should call tool again on second request', async ({ page }) => {
    // First turn: draw cards
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('draw 3 cards', { delay: 10 })
    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for card picker and pick a card
    const cardButtons = page.locator('button').filter({ hasText: /[♠♥♦♣]/ })
    await expect(cardButtons.first()).toBeVisible({ timeout: 30000 })
    await cardButtons.first().click()

    // Wait for assistant response
    await expect(page.getByText(/selected|picked|choice|chose/i)).toBeVisible({ timeout: 30000 })

    // Wait for streaming to complete - check the input is no longer disabled
    await expect(input).toBeEnabled({ timeout: 15000 })
    
    // Also wait for the "streaming..." indicator to disappear
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 15000 })

    // Second turn: ask for more cards
    await input.pressSequentially('draw 2 more cards', { delay: 10 })
    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for NEW card picker to appear (second set of cards)
    // After picking a card, the first CardPicker shows "You picked: X"
    // So we need to check for interactive card buttons in the second picker
    // Wait for new card buttons to appear (the ones from the second draw)
    // We can verify by checking we have more than 3 card elements total
    // (first 3 are now disabled, second set should be clickable)
    const newCardPicker = page.locator('text=Pick one of these').last()
    await expect(newCardPicker).toBeVisible({ timeout: 30000 })
    
    // Verify the second card picker has interactive buttons
    // Wait longer since the LLM response may still be streaming
    const interactiveButtons = page.locator('button:not([disabled])').filter({ hasText: /[♠♥♦♣]/ })
    await expect(interactiveButtons.first()).toBeVisible({ timeout: 30000 })
  })

  test('history should include tool_calls after first turn', async ({ page }) => {
    // This test uses console logs to verify the message format
    // We intercept console.log to check what's being sent to the server
    
    const serverRequests: any[] = []
    
    // Intercept the chat API request
    await page.route('**/api/chat', async (route) => {
      const request = route.request()
      const postData = request.postDataJSON()
      serverRequests.push(postData)
      await route.continue()
    })

    // First turn: draw cards
    const input = page.getByPlaceholder('Type a message...')
    await input.pressSequentially('draw 3 cards please', { delay: 10 })
    await page.getByRole('button', { name: 'Send' }).click()

    // Wait for card picker
    const cardButtons = page.locator('button').filter({ hasText: /[♠♥♦♣]/ })
    await expect(cardButtons.first()).toBeVisible({ timeout: 30000 })
    
    // Pick a card
    await cardButtons.first().click()

    // Wait for response
    await expect(page.getByText(/selected|picked|choice|chose/i)).toBeVisible({ timeout: 30000 })
    
    // Wait for streaming to complete - check input is enabled
    await expect(input).toBeEnabled({ timeout: 15000 })
    
    // Also wait for streaming indicator to disappear
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 15000 })

    // Second turn
    await input.pressSequentially('draw 2 more cards', { delay: 10 })
    await page.getByRole('button', { name: 'Send' }).click()

    // Wait a moment for request to be sent
    await page.waitForTimeout(2000)

    // Check the second request's messages
    expect(serverRequests.length).toBeGreaterThanOrEqual(2)
    
    const secondRequest = serverRequests[serverRequests.length - 1]
    const messages = secondRequest.messages

    // Find assistant message with tool_calls
    const assistantWithToolCalls = messages.find(
      (m: any) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
    )
    
    expect(assistantWithToolCalls).toBeDefined()
    expect(assistantWithToolCalls.tool_calls[0].function).toBeDefined()
    expect(assistantWithToolCalls.tool_calls[0].function.name).toBe('pick_card')

    // Find tool result message
    const toolResult = messages.find(
      (m: any) => m.role === 'tool' && m.tool_call_id
    )
    
    expect(toolResult).toBeDefined()
    expect(toolResult.content).toBeTruthy()
    expect(toolResult.content).not.toBe('')
  })
})
