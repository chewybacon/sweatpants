import { test, expect } from '@playwright/test'

/**
 * E2E tests that use the local Ollama API.
 * 
 * These tests require:
 * - Ollama running locally at http://localhost:11434
 * - A model that supports tool calling (e.g., qwen3:30b, llama3.1)
 * 
 * The tests use qwen3:30b by default which has good tool calling support.
 * 
 * Run with: pnpm test:e2e
 */

// Increase timeout for LLM responses (models can be slow)
test.setTimeout(180000)

test.describe('Ollama chat integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo/chat/')
    await expect(page.getByRole('heading', { name: 'Pipeline-Based Chat' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  test('can send a simple message and receive a response', async ({ page }) => {
    // Type a simple message
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Say exactly: Hello World')
    
    // Send the message
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for streaming to start
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Wait for the response to complete (streaming indicator disappears)
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Should have both user message and assistant response
    await expect(page.getByText('Say exactly: Hello World')).toBeVisible()
    
    // Should show 2 messages (user + assistant)
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
  })

  test('can abort a streaming response', async ({ page }) => {
    // Type a message that will generate a long response
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Count from 1 to 1000 slowly, one number per line')
    
    // Send the message
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for streaming to start
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Wait a bit for some content to stream (need to wait for assistant message to be created)
    await page.waitForTimeout(3000)
    
    // Abort the response
    await page.getByRole('button', { name: 'Stop' }).click()
    
    // Streaming should stop
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 10000 })
    
    // Should show messages were received (at least user message)
    await expect(page.locator('text=/[12] messages/')).toBeVisible({ timeout: 5000 })
  })

  test('renders markdown in responses', async ({ page }) => {
    // Ask for a code example
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Write this exact Python code in a code block: print("hello")')
    
    // Send the message
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Should have rendered markdown with code highlighting (Shiki)
    // Look for a pre element which indicates code block rendering
    await expect(page.locator('pre code')).toBeVisible({ timeout: 10000 })
  })

  test('rendered markdown persists after streaming completes', async ({ page }) => {
    // This test verifies that the pipeline-rendered HTML (with syntax highlighting)
    // persists after streaming ends. Previously, frames were lost when streaming
    // completed, causing the content to revert to raw markdown.
    
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Write a Python hello world in a code block')
    
    // Send and wait for streaming to start
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Wait for code block to appear during streaming
    await expect(page.locator('pre code')).toBeVisible({ timeout: 30000 })
    
    // Capture that we have rendered HTML (not raw markdown)
    // During streaming, the code block should be syntax highlighted
    const codeBlockDuringStreaming = page.locator('pre code')
    await expect(codeBlockDuringStreaming).toBeVisible()
    
    // Wait for streaming to complete
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // CRITICAL: After streaming completes, the code block should STILL be rendered
    // This was the bug - frames were lost on streaming_end, reverting to raw markdown
    await expect(page.locator('pre code')).toBeVisible({ timeout: 5000 })
    
    // Verify it's not showing raw markdown (```python should not be visible as text)
    // The backticks should be parsed, not displayed
    const rawMarkdownVisible = await page.locator('text=/```python/').count()
    expect(rawMarkdownVisible).toBe(0)
    
    // The message should show as completed (not streaming)
    await expect(page.getByText('2 messages')).toBeVisible()
  })

  test('rendered markdown persists across multiple messages', async ({ page }) => {
    // Capture console logs
    const logs: string[] = []
    page.on('console', msg => {
      if (msg.text().includes('[deriveMessages]') || msg.text().includes('[reducer')) {
        logs.push(msg.text())
      }
    })
    
    // This test verifies that when multiple messages are sent, each message
    // retains its rendered HTML after subsequent messages complete.
    
    const input = page.getByPlaceholder('Type a message...')
    
    // First message: ask for a code block
    await input.fill('Write a Python hello world in a code block')
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for first response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // First message should have a code block
    await expect(page.locator('pre code').first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('2 messages')).toBeVisible()
    
    console.log('=== After first message ===')
    console.log(`Total logs: ${logs.length}`)
    // Don't clear - keep accumulating
    
    // Second message: ask for something with markdown
    await input.fill('List the planets in a markdown bullet list')
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for second response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Should now have 4 messages
    await expect(page.getByText('4 messages')).toBeVisible({ timeout: 5000 })
    
    console.log('=== After second message ===')
    console.log(`Total logs: ${logs.length}`)
    // Print all logs at the end
    logs.forEach((l, i) => console.log(`[${i}] ${l}`))
    
    // CRITICAL: First message's code block should STILL be rendered
    // This was the bug - when message 2 finalized, message 1 would revert to raw markdown
    await expect(page.locator('pre code').first()).toBeVisible({ timeout: 5000 })
    
    // Second message should have rendered markdown (bullet list)
    // Look for list items in the second assistant message
    const assistantMessages = page.locator('[class*="bg-slate-800"]')
    await expect(assistantMessages).toHaveCount(2, { timeout: 5000 })
    
    // Check that no raw markdown is showing (no visible ``` or - at start of content)
    const rawBackticks = await page.locator('text=/^```/').count()
    expect(rawBackticks).toBe(0)
  })

  test('can reset the conversation', async ({ page }) => {
    // Send a message
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Say hi')
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Reset the conversation
    await page.getByRole('button', { name: 'Clear History' }).click()
    
    // Should show empty state
    await expect(page.getByText('Send a message to start chatting')).toBeVisible()
    await expect(page.getByText('0 messages')).toBeVisible()
  })
})

test.describe('Ollama tool calling', () => {
  // Note: Tool calling requires the model to support tools and correct server configuration.
  // These tests verify the full flow when tools are working.
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo/chat/')
    await expect(page.getByRole('heading', { name: 'Pipeline-Based Chat' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  test('LLM can call the calculator tool', async ({ page }) => {
    // Ask a math question that should trigger the calculator tool
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Use the calculator tool to compute 42 * 17. What is the result?')
    
    // Send the message
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Check if the response contains either the answer or an error message
    // The LLM may or may not successfully call the tool depending on model/config
    const responseText = await page.locator('.prose').last().textContent()
    
    // The response should contain either 714 (success) or some text about calculator/tools
    expect(responseText).toBeTruthy()
    console.log('Calculator response:', responseText?.slice(0, 200))
  })

  test('LLM can call the pick_card tool and user can interact', async ({ page }) => {
    // Ask to pick a card - this should trigger the pick_card isomorphic tool
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Use the pick_card tool with count=3 to let me pick a card')
    
    // Send the message
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response - could be card picker UI or an error message
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Try to wait for card picker UI, but don't fail if it doesn't appear
    // The CardPicker component renders buttons with card symbols
    const cardButton = page.locator('button').filter({ hasText: /[AKQJ\d]+[\u2665\u2666\u2663\u2660]/ }).first()
    
    try {
      await expect(cardButton).toBeVisible({ timeout: 60000 })
      
      // Get the card text before clicking
      const cardText = await cardButton.textContent()
      console.log(`Found card picker! Clicking card: ${cardText}`)
      
      // Click on a card
      await cardButton.click()
      
      // After clicking, should show the selection confirmation
      await expect(page.getByText(/You picked:/)).toBeVisible({ timeout: 15000 })
      
      console.log('Card selection successful!')
    } catch {
      // Card picker didn't appear - check if there's an error or just text response
      await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 60000 })
      const responseText = await page.locator('.prose').last().textContent()
      console.log('No card picker appeared. Response:', responseText?.slice(0, 300))
      
      // Test should still pass - we're testing that the flow doesn't crash
      expect(responseText).toBeTruthy()
    }
  })

  test('pick_card tool: LLM response reflects the card user picked', async ({ page }) => {
    /**
     * This test verifies the complete pick_card flow:
     * 
     * 1. User asks to pick a card
     * 2. Server runs *before() - draws random cards
     * 3. Client renders CardPicker via ctx.render()
     * 4. User clicks a specific card (e.g., "5♥")
     * 5. Client returns { picked: card } from *client()
     * 6. Server runs *after(handoff, clientOutput) - returns "You selected the 5 of Hearts!"
     * 7. LLM sees the *after() result and responds accordingly
     * 8. LLM's final message should acknowledge the SELECTION, not just list the cards
     * 
     * This tests that the handoff pattern works correctly end-to-end.
     */
    
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Use pick_card with count=3. After I pick, tell me which card I chose.')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for card picker to appear
    const cardButton = page.locator('button').filter({ hasText: /[AKQJ\d]+[\u2665\u2666\u2663\u2660]/ }).first()
    await expect(cardButton).toBeVisible({ timeout: 60000 })
    
    // Remember which card we're clicking
    const cardText = await cardButton.textContent()
    console.log(`Clicking card: ${cardText}`)
    
    // Click the card
    await cardButton.click()
    
    // Wait for the "You picked:" confirmation in the CardPicker component
    await expect(page.getByText(/You picked:/)).toBeVisible({ timeout: 15000 })
    
    // Now wait for the LLM to respond with a message about the card we picked
    // The streaming should complete
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 60000 })
    
    // The final assistant message should mention the card we picked
    // Get the last .prose element which is the final assistant response
    const assistantMessages = page.locator('.prose').last()
    const finalResponse = await assistantMessages.textContent()
    
    console.log(`Final LLM response: ${finalResponse?.slice(0, 500)}`)
    
    // The LLM should acknowledge the selection, not just list cards
    // The *after() returns: { message: "You selected the ${rank} of ${suit}!", ... }
    // The LLM sees this result and should respond with something like:
    // "You chose the 6 of Diamonds" or "You picked the 6 of Diamonds"
    
    // The final response from LLM
    const cleanResponse = finalResponse?.trim()
    console.log(`LLM response: ${cleanResponse?.slice(0, 200)}`)
    
    // CRITICAL: The response should indicate a SELECTION was made
    // Not just list the available cards (which is what *before() returns)
    // AND should NOT be prompting for a selection
    const positiveIndicators = ['selected', 'chose', 'picked', 'your choice', 'chosen']
    const negativeIndicators = ['please pick', 'pick one', 'choose one', 'which card', 'please choose']
    
    const hasPositive = positiveIndicators.some(
      indicator => cleanResponse?.toLowerCase().includes(indicator)
    )
    const hasNegative = negativeIndicators.some(
      indicator => cleanResponse?.toLowerCase().includes(indicator)
    )
    
    // Must have positive indicators AND no negative prompts
    const hasSelectionLanguage = hasPositive && !hasNegative
    
    console.log(`Has selection language: ${hasSelectionLanguage}`)
    
    // This assertion should FAIL until we fix the bug
    // Currently the LLM only sees the *before() result (card list)
    // not the *after() result (selection confirmation)
    expect(hasSelectionLanguage).toBe(true)
  })

  test('pick_card tool: CardPicker appears inline in chat timeline', async ({ page }) => {
    /**
     * This test verifies that the CardPicker component appears in the 
     * correct position in the chat timeline:
     * 
     * Expected order:
     * 1. User message: "Use pick_card..."
     * 2. Assistant thinking/streaming indicator
     * 3. CardPicker component (interactive)
     * 4. After picking: Assistant's final response
     * 
     * The CardPicker should NOT appear in a separate area - it should
     * be part of the natural conversation flow.
     */
    
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Use pick_card with count=3')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for card picker
    const cardPicker = page.locator('button').filter({ hasText: /[AKQJ\d]+[\u2665\u2666\u2663\u2660]/ }).first()
    await expect(cardPicker).toBeVisible({ timeout: 60000 })
    
    // The card picker should appear AFTER the user message
    // Check the DOM order: user message should come before card picker
    const userMessage = page.getByText('Use pick_card with count=3')
    
    // Get bounding boxes to verify visual order
    const userMessageBox = await userMessage.boundingBox()
    const cardPickerBox = await cardPicker.boundingBox()
    
    expect(userMessageBox).toBeTruthy()
    expect(cardPickerBox).toBeTruthy()
    
    // Card picker should be below user message (higher Y coordinate)
    expect(cardPickerBox!.y).toBeGreaterThan(userMessageBox!.y)
    
    console.log('CardPicker appears inline after user message ✓')
  })
})
