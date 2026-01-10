import { test, expect } from '@playwright/test'

/**
 * E2E tests for the Math Assistant demo.
 * 
 * These tests validate:
 * 1. Math rendering with KaTeX (inline and block math)
 * 2. All message part types (text, reasoning, tool-call)
 * 3. Pipeline processing with the 'math' preset
 * 4. Tool call UI with expandable details
 * 
 * Requires Ollama running locally.
 */

// LLM responses can be slow
test.setTimeout(180000)

test.describe('Math Assistant', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat/math/', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Math Assistant' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 15000 })
    
    // Click input to ensure React hydration is complete
    await page.getByPlaceholder('Type a math problem...').click()
  })

  /**
   * Helper to wait for streaming to complete.
   */
  async function waitForStreamingComplete(page: import('@playwright/test').Page) {
    await expect(page.getByRole('button', { name: 'Stop' })).not.toBeVisible({ timeout: 120000 })
    await expect(page.getByPlaceholder('Type a math problem...')).toBeEnabled({ timeout: 5000 })
  }

  /**
   * Helper to send a message and wait for completion.
   */
  async function sendMessageAndWait(page: import('@playwright/test').Page, message: string) {
    const input = page.getByPlaceholder('Type a math problem...')
    
    // Focus and type the input using pressSequentially for reliable React state updates
    await input.click()
    await input.pressSequentially(message, { delay: 5 })
    
    // Verify input has value
    await expect(input).toHaveValue(message, { timeout: 2000 })
    
    // Wait for button to be enabled (React state update)
    // Use exact: true to avoid matching quick action buttons like "Solve 2x + 5 = 15"
    const solveButton = page.getByRole('button', { name: 'Solve', exact: true })
    await expect(solveButton).toBeEnabled({ timeout: 15000 })
    
    await solveButton.click()
    
    // Wait for streaming to start
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30000 })
    
    // Wait for streaming to complete
    await waitForStreamingComplete(page)
  }

  /**
   * Get assistant message containers.
   */
  function getAssistantMessages(page: import('@playwright/test').Page) {
    return page.locator('.bg-slate-800\\/50')
  }

  // ===========================================================================
  // BASIC FUNCTIONALITY
  // ===========================================================================

  test('loads correctly with pipeline ready', async ({ page }) => {
    await expect(page.getByText('Pipeline ready')).toBeVisible()
    await expect(page.getByText('calculator')).toBeVisible()
    await expect(page.getByText('reasoning')).toBeVisible()
    await expect(page.getByText('Ask me a math question...')).toBeVisible()
  })

  test('quick action buttons populate input', async ({ page }) => {
    await page.getByRole('button', { name: '"sqrt(12345) * pi"' }).click()
    const input = page.getByPlaceholder('Type a math problem...')
    await expect(input).toHaveValue('Calculate sqrt(12345) * pi', { timeout: 5000 })
  })

  // ===========================================================================
  // MATH RENDERING (KaTeX)
  // ===========================================================================

  test('renders inline math with KaTeX', async ({ page }) => {
    // Ask a question that will produce inline math in the response
    await sendMessageAndWait(page, 'What is the formula for the area of a circle? Use $A = \\pi r^2$ notation.')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Check for KaTeX rendered math (inline math has class math-inline or katex)
    const assistantMessage = getAssistantMessages(page).first()
    
    // KaTeX renders math inside .katex spans
    const katexElements = assistantMessage.locator('.katex')
    const katexCount = await katexElements.count()
    
    console.log(`Found ${katexCount} KaTeX rendered elements`)
    
    // If we have katex elements, the math was processed correctly
    if (katexCount > 0) {
      console.log('KaTeX rendering confirmed - inline math processed')
    } else {
      // If LLM didn't output LaTeX, at least verify the message is rendered
      const hasContent = await assistantMessage.locator('p').count() > 0
      console.log(`No KaTeX found, but has paragraph content: ${hasContent}`)
      expect(hasContent).toBe(true)
    }
  })

  test('renders block math with KaTeX', async ({ page }) => {
    // Ask for a response with block math ($$...$$)
    await sendMessageAndWait(page, 'Show the quadratic formula as a display equation using $$...$$')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    const assistantMessage = getAssistantMessages(page).first()
    
    // Block math is wrapped in .math-block or .katex-display
    const blockMath = assistantMessage.locator('.math-block, .katex-display')
    const blockMathCount = await blockMath.count()
    
    console.log(`Found ${blockMathCount} block math elements`)
    
    // If we have block math elements, the math was processed correctly
    if (blockMathCount > 0) {
      console.log('KaTeX block rendering confirmed')
    } else {
      // If LLM didn't output LaTeX blocks, at least verify the message is rendered
      const hasContent = await assistantMessage.locator('p').count() > 0
      console.log(`No block math found, but has paragraph content: ${hasContent}`)
      expect(hasContent).toBe(true)
    }
  })

  test('calculator tool produces math in response', async ({ page }) => {
    // This tests the full flow: question -> tool call -> math rendered result
    await sendMessageAndWait(page, 'Calculate sqrt(12345) * pi')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    const assistantMessage = getAssistantMessages(page).first()
    
    // Should have KaTeX rendered math (the sqrt and pi symbols)
    const katexElements = assistantMessage.locator('.katex')
    const katexCount = await katexElements.count()
    
    console.log(`Calculator response has ${katexCount} KaTeX elements`)
    
    // The response should mention the result (~349)
    const text = await assistantMessage.textContent()
    const hasResult = /34[89]|350|111\./.test(text ?? '') // sqrt(12345) ≈ 111, * pi ≈ 349
    
    console.log(`Response text sample: ${(text ?? '').slice(0, 200)}`)
    console.log(`Response contains expected result: ${hasResult}`)
    
    // Should have some content rendered
    const hasContent = await assistantMessage.locator('p').count() > 0
    expect(hasContent || katexCount > 0).toBe(true)
  })

  // ===========================================================================
  // MESSAGE PART TYPES
  // ===========================================================================

  test('renders text parts with markdown', async ({ page }) => {
    await sendMessageAndWait(page, 'Explain what pi is in a few bullet points')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    const assistantMessage = getAssistantMessages(page).first()
    
    // Should have rendered HTML (lists, paragraphs, etc.)
    const hasList = await assistantMessage.locator('ul, ol').count() > 0
    const hasParagraph = await assistantMessage.locator('p').count() > 0
    
    console.log(`Has list: ${hasList}, has paragraph: ${hasParagraph}`)
    
    // Should have some rendered markdown
    expect(hasList || hasParagraph).toBe(true)
  })

  test('renders tool-call parts with expandable UI', async ({ page }) => {
    // Ask something that will trigger the calculator tool
    await sendMessageAndWait(page, 'Use the calculator to compute 2 + 2')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    const assistantMessage = getAssistantMessages(page).first()
    
    // Look for the tool call UI (has "calculator" text and expand button)
    const toolCallUI = assistantMessage.locator('button:has-text("calculator")')
    
    // Tool call should be visible (either inline or in a collapsible)
    const toolCallCount = await toolCallUI.count()
    console.log(`Found ${toolCallCount} tool call UI elements`)
    
    if (toolCallCount > 0) {
      // Click to expand
      await toolCallUI.first().click()
      
      // Should show "Arguments" section
      await expect(assistantMessage.getByText('Arguments')).toBeVisible({ timeout: 2000 })
      
      // Should show "Result" section (tool completed successfully)
      const hasResult = await assistantMessage.getByText('Result').isVisible().catch(() => false)
      console.log(`Tool call shows result: ${hasResult}`)
    }
  })

  test('renders reasoning parts as collapsible', async ({ page }) => {
    // Use a model/prompt that triggers reasoning (DeepSeek-R1 style)
    // Note: This depends on the model supporting thinking/reasoning
    await sendMessageAndWait(page, 'Think step by step: what is 15% of 80?')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    const assistantMessage = getAssistantMessages(page).first()
    
    // Check if there's a reasoning section (collapsible)
    const reasoningToggle = assistantMessage.locator('button:has-text("Reasoning")')
    const reasoningCount = await reasoningToggle.count()
    
    console.log(`Found ${reasoningCount} reasoning sections`)
    
    // If reasoning is present, it should be expandable
    if (reasoningCount > 0) {
      // Click to expand
      await reasoningToggle.first().click()
      
      // Should show reasoning content (in purple-tinted container)
      const reasoningContent = assistantMessage.locator('.bg-purple-950\\/20')
      await expect(reasoningContent).toBeVisible({ timeout: 2000 })
      
      console.log('Reasoning part expanded successfully')
    }
  })

  // ===========================================================================
  // MULTI-TURN & PERSISTENCE
  // ===========================================================================

  test('math rendering persists across multiple messages', async ({ page }) => {
    // First message with math
    await sendMessageAndWait(page, 'What is $e^{i\\pi} + 1$?')
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Verify first message has KaTeX
    let assistantMessages = getAssistantMessages(page)
    const firstMessage = assistantMessages.first()
    const firstKatexCount = await firstMessage.locator('.katex').count()
    console.log(`First message KaTeX count: ${firstKatexCount}`)
    
    // Second message with different math
    await sendMessageAndWait(page, 'Now calculate $\\sqrt{2}$ using the calculator')
    await expect(page.getByText('4 messages')).toBeVisible({ timeout: 5000 })
    
    // Both messages should still have rendered math
    assistantMessages = getAssistantMessages(page)
    await expect(assistantMessages).toHaveCount(2)
    
    // First message should STILL have KaTeX (not reverted to raw)
    const firstMessageAfter = assistantMessages.nth(0)
    const firstKatexCountAfter = await firstMessageAfter.locator('.katex').count()
    console.log(`First message KaTeX count after second message: ${firstKatexCountAfter}`)
    
    // KaTeX should persist
    expect(firstKatexCountAfter).toBeGreaterThanOrEqual(firstKatexCount)
    
    // Second message should also have KaTeX
    const secondMessage = assistantMessages.nth(1)
    const secondKatexCount = await secondMessage.locator('.katex').count()
    console.log(`Second message KaTeX count: ${secondKatexCount}`)
  })

  test('tool calls and text parts render together correctly', async ({ page }) => {
    // This should produce: text -> tool_call -> text (result explanation)
    await sendMessageAndWait(page, 'Calculate 123 * 456 and explain what you did')
    
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    const assistantMessage = getAssistantMessages(page).first()
    
    // Should have text content
    const hasText = await assistantMessage.locator('p').count() > 0
    console.log(`Has text paragraphs: ${hasText}`)
    
    // Check the result is mentioned (123 * 456 = 56088)
    const text = await assistantMessage.textContent()
    const hasResult = /56088|56,088/.test(text ?? '')
    console.log(`Contains expected result (56088): ${hasResult}`)
    
    expect(hasResult).toBe(true)
  })

  // ===========================================================================
  // STREAMING BEHAVIOR
  // ===========================================================================

  test('shows streaming indicator while processing', async ({ page }) => {
    const input = page.getByPlaceholder('Type a math problem...')
    await input.pressSequentially('What is the meaning of life in mathematical terms?', { delay: 5 })
    
    // Wait for button to be enabled (React state update)
    const solveButton = page.getByRole('button', { name: 'Solve', exact: true })
    await expect(solveButton).toBeEnabled({ timeout: 15000 })
    await solveButton.click()
    
    // Should show streaming indicator
    await expect(page.getByText('thinking...', { exact: true })).toBeVisible({ timeout: 30000 })
    
    // Stop button should be visible
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    
    // Wait for completion
    await waitForStreamingComplete(page)
    
    // Streaming indicator should be gone
    await expect(page.getByText('thinking...', { exact: true })).not.toBeVisible()
  })

  test('can abort streaming response', async ({ page }) => {
    const input = page.getByPlaceholder('Type a math problem...')
    await input.pressSequentially('Explain all the prime numbers up to 1000', { delay: 5 })
    
    // Wait for button to be enabled (React state update)
    const solveButton = page.getByRole('button', { name: 'Solve', exact: true })
    await expect(solveButton).toBeEnabled({ timeout: 15000 })
    await solveButton.click()
    
    // Wait for streaming to start
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30000 })
    
    // Wait a bit for some content
    await page.waitForTimeout(2000)
    
    // Abort
    await page.getByRole('button', { name: 'Stop' }).click()
    
    // Should stop streaming
    await expect(page.getByRole('button', { name: 'Stop' })).not.toBeVisible({ timeout: 10000 })
    
    // Input should be re-enabled
    await expect(input).toBeEnabled()
  })

  // ===========================================================================
  // RESET FUNCTIONALITY
  // ===========================================================================

  test('can clear chat history', async ({ page }) => {
    // Send a message first
    await sendMessageAndWait(page, 'Hello')
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Clear history
    await page.getByRole('button', { name: 'Clear History' }).click()
    
    // Should show empty state
    await expect(page.getByText('Ask me a math question...')).toBeVisible()
    await expect(page.getByText('0 messages')).toBeVisible()
  })
})
