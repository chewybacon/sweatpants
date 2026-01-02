import { test, expect } from '@playwright/test'

/**
 * E2E tests for markdown rendering persistence across multiple messages.
 * 
 * These tests verify that:
 * 1. Markdown is rendered to HTML (not shown as raw text)
 * 2. Rendered HTML persists after streaming completes
 * 3. Previous messages retain their rendered HTML when new messages are sent
 * 4. Mermaid diagrams are rendered to SVG
 * 
 * Requires Ollama running locally with a model that can follow instructions.
 */

// LLM responses can be slow
test.setTimeout(180000)

test.describe('Markdown rendering persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo/chat/')
    await expect(page.getByRole('heading', { name: 'Pipeline-Based Chat' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  /**
   * Helper to wait for streaming to complete.
   * Checks that:
   * - Stop button is not visible
   * - Input is enabled (not disabled)
   */
  async function waitForStreamingComplete(page: import('@playwright/test').Page) {
    // Wait for Stop button to disappear (streaming ended)
    await expect(page.getByRole('button', { name: 'Stop' })).not.toBeVisible({ timeout: 120000 })
    
    // Wait for input to be enabled
    await expect(page.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 5000 })
  }

  /**
   * Helper to send a message and wait for completion.
   */
  async function sendMessageAndWait(page: import('@playwright/test').Page, message: string) {
    const input = page.getByPlaceholder('Type a message...')
    await input.fill(message)
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for streaming to start
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30000 })
    
    // Wait for streaming to complete
    await waitForStreamingComplete(page)
  }

  /**
   * Helper to get all assistant message containers.
   */
  function getAssistantMessages(page: import('@playwright/test').Page) {
    // Assistant messages have bg-slate-800/50 class
    return page.locator('.bg-slate-800\\/50')
  }

  /**
   * Helper to check if an element contains rendered HTML (not raw markdown).
   * Raw markdown would show backticks, asterisks, etc.
   */
  async function hasRenderedMarkdown(locator: import('@playwright/test').Locator): Promise<boolean> {
    // Check for common rendered HTML elements
    const hasPreCode = await locator.locator('pre code').count() > 0
    const hasHeading = await locator.locator('h1, h2, h3, h4, h5, h6').count() > 0
    const hasList = await locator.locator('ul, ol').count() > 0
    const hasTable = await locator.locator('table').count() > 0
    const hasParagraph = await locator.locator('p').count() > 0
    const hasStrong = await locator.locator('strong, em').count() > 0
    
    return hasPreCode || hasHeading || hasList || hasTable || hasParagraph || hasStrong
  }

  /**
   * Helper to check for raw markdown indicators (should NOT be visible).
   * 
   * This is tricky because rendered content can still have text that looks like
   * markdown (e.g., "1." at the start of a line in a paragraph).
   * We focus on patterns that should NEVER appear in rendered output.
   */
  async function hasRawMarkdown(locator: import('@playwright/test').Locator): Promise<boolean> {
    const text = await locator.textContent() ?? ''
    
    // Check for code fence markers - these should NEVER be visible in rendered output
    if (/^```/m.test(text)) {
      // But only if there's no rendered code block
      const hasCodeBlock = await locator.locator('pre code').count() > 0
      if (!hasCodeBlock) return true
    }
    
    // Check for heading markers like "## Title" - these should become <h2>Title</h2>
    // But only flag if there's NO rendered heading
    if (/^#{1,6}\s/m.test(text)) {
      const hasHeading = await locator.locator('h1, h2, h3, h4, h5, h6').count() > 0
      if (!hasHeading) return true
    }
    
    // Check for table pipes only if there's no rendered table
    if (/\|.*\|.*\|/.test(text)) {
      const hasTable = await locator.locator('table').count() > 0
      if (!hasTable) return true
    }
    
    // List markers are harder to detect because rendered lists still show bullets
    // We'll skip checking those - the presence of <ul>/<ol> is enough
    
    return false
  }

  test('Message 1: quantum computing has rendered markdown after completion', async ({ page }) => {
    // Send first message
    await sendMessageAndWait(page, 'Tell me about quantum computing')
    
    // Should have 2 messages (user + assistant)
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Get the assistant message
    const assistantMessages = getAssistantMessages(page)
    await expect(assistantMessages).toHaveCount(1)
    
    const firstMessage = assistantMessages.first()
    
    // Should have rendered markdown (paragraphs, possibly headings, lists, etc.)
    const hasRendered = await hasRenderedMarkdown(firstMessage)
    expect(hasRendered).toBe(true)
    
    // Should NOT show raw markdown
    const hasRaw = await hasRawMarkdown(firstMessage)
    expect(hasRaw).toBe(false)
  })

  test('Message 2: planets table - both messages have rendered markdown', async ({ page }) => {
    // Send first message
    await sendMessageAndWait(page, 'Tell me about quantum computing')
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Verify first message has rendered markdown
    const assistantMessages1 = getAssistantMessages(page)
    const firstMessage = assistantMessages1.first()
    expect(await hasRenderedMarkdown(firstMessage)).toBe(true)
    expect(await hasRawMarkdown(firstMessage)).toBe(false)
    
    // Send second message asking for a table
    await sendMessageAndWait(page, 'Write out the planets in a markdown table')
    
    // Should now have 4 messages (2 user + 2 assistant)
    await expect(page.getByText('4 messages')).toBeVisible({ timeout: 5000 })
    
    // Get both assistant messages
    const assistantMessages2 = getAssistantMessages(page)
    await expect(assistantMessages2).toHaveCount(2)
    
    // CRITICAL: First message should STILL have rendered markdown
    const firstMessageAfter = assistantMessages2.nth(0)
    expect(await hasRenderedMarkdown(firstMessageAfter)).toBe(true)
    expect(await hasRawMarkdown(firstMessageAfter)).toBe(false)
    
    // Second message should have rendered markdown (ideally a table)
    const secondMessage = assistantMessages2.nth(1)
    expect(await hasRenderedMarkdown(secondMessage)).toBe(true)
    expect(await hasRawMarkdown(secondMessage)).toBe(false)
    
    // Bonus: check if we got a table
    const hasTable = await secondMessage.locator('table').count() > 0
    console.log(`Second message has table: ${hasTable}`)
  })

  test('Message 3: mermaid diagram - all three messages have rendered markdown', async ({ page }) => {
    // Send first message
    await sendMessageAndWait(page, 'Tell me about quantum computing')
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Send second message
    await sendMessageAndWait(page, 'Write out the planets in a markdown table')
    await expect(page.getByText('4 messages')).toBeVisible({ timeout: 5000 })
    
    // Send third message asking for mermaid
    await sendMessageAndWait(page, 'Show me rock paper scissors in a mermaid diagram')
    
    // Should now have 6 messages (3 user + 3 assistant)
    await expect(page.getByText('6 messages')).toBeVisible({ timeout: 5000 })
    
    // Get all assistant messages
    const assistantMessages = getAssistantMessages(page)
    await expect(assistantMessages).toHaveCount(3)
    
    // CRITICAL: All three messages should have rendered markdown
    for (let i = 0; i < 3; i++) {
      const message = assistantMessages.nth(i)
      const hasRendered = await hasRenderedMarkdown(message)
      const hasRaw = await hasRawMarkdown(message)
      
      console.log(`Message ${i + 1}: hasRendered=${hasRendered}, hasRaw=${hasRaw}`)
      
      expect(hasRendered).toBe(true)
      expect(hasRaw).toBe(false)
    }
    
    // Third message should have a mermaid diagram rendered as SVG
    const thirdMessage = assistantMessages.nth(2)
    const hasMermaidSvg = await thirdMessage.locator('svg').count() > 0
    const hasMermaidImg = await thirdMessage.locator('img[src*="mermaid"]').count() > 0
    
    console.log(`Third message has mermaid SVG: ${hasMermaidSvg}, img: ${hasMermaidImg}`)
    
    // Should have either SVG or img for mermaid
    expect(hasMermaidSvg || hasMermaidImg).toBe(true)
  })

  test('Full three-message flow in single test', async ({ page }) => {
    /**
     * This is the main test that verifies the complete flow:
     * 1. Quantum computing message - rendered markdown
     * 2. Planets table message - both messages still rendered
     * 3. Mermaid diagram message - all three messages rendered, mermaid has SVG
     */
    
    const input = page.getByPlaceholder('Type a message...')
    
    // === MESSAGE 1: Quantum Computing ===
    console.log('--- Sending message 1: quantum computing ---')
    await input.fill('Tell me about quantum computing')
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for streaming to start and complete
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30000 })
    await waitForStreamingComplete(page)
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // Verify message 1 has rendered markdown
    let assistantMessages = getAssistantMessages(page)
    await expect(assistantMessages).toHaveCount(1)
    
    let msg1 = assistantMessages.nth(0)
    expect(await hasRenderedMarkdown(msg1)).toBe(true)
    expect(await hasRawMarkdown(msg1)).toBe(false)
    console.log('Message 1: rendered markdown verified')
    
    // === MESSAGE 2: Planets Table ===
    console.log('--- Sending message 2: planets table ---')
    await input.fill('Write out the planets in a markdown table')
    await page.getByRole('button', { name: 'Send' }).click()
    
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30000 })
    await waitForStreamingComplete(page)
    await expect(page.getByText('4 messages')).toBeVisible({ timeout: 5000 })
    
    // Verify both messages have rendered markdown
    assistantMessages = getAssistantMessages(page)
    await expect(assistantMessages).toHaveCount(2)
    
    msg1 = assistantMessages.nth(0)
    const msg2 = assistantMessages.nth(1)
    
    // CRITICAL CHECK: Message 1 should STILL be rendered
    expect(await hasRenderedMarkdown(msg1)).toBe(true)
    expect(await hasRawMarkdown(msg1)).toBe(false)
    console.log('Message 1 after message 2: still rendered')
    
    expect(await hasRenderedMarkdown(msg2)).toBe(true)
    expect(await hasRawMarkdown(msg2)).toBe(false)
    console.log('Message 2: rendered markdown verified')
    
    // === MESSAGE 3: Mermaid Diagram ===
    console.log('--- Sending message 3: mermaid diagram ---')
    await input.fill('Show me rock paper scissors in a mermaid diagram')
    await page.getByRole('button', { name: 'Send' }).click()
    
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30000 })
    await waitForStreamingComplete(page)
    await expect(page.getByText('6 messages')).toBeVisible({ timeout: 5000 })
    
    // Verify all three messages have rendered markdown
    assistantMessages = getAssistantMessages(page)
    await expect(assistantMessages).toHaveCount(3)
    
    msg1 = assistantMessages.nth(0)
    const msg2After = assistantMessages.nth(1)
    const msg3 = assistantMessages.nth(2)
    
    // CRITICAL CHECKS: All previous messages should still be rendered
    expect(await hasRenderedMarkdown(msg1)).toBe(true)
    expect(await hasRawMarkdown(msg1)).toBe(false)
    console.log('Message 1 after message 3: still rendered')
    
    expect(await hasRenderedMarkdown(msg2After)).toBe(true)
    expect(await hasRawMarkdown(msg2After)).toBe(false)
    console.log('Message 2 after message 3: still rendered')
    
    expect(await hasRenderedMarkdown(msg3)).toBe(true)
    expect(await hasRawMarkdown(msg3)).toBe(false)
    console.log('Message 3: rendered markdown verified')
    
    // Check for mermaid SVG in message 3
    const hasMermaidSvg = await msg3.locator('svg').count() > 0
    console.log(`Message 3 has mermaid SVG: ${hasMermaidSvg}`)
    
    // This should pass once the bug is fixed
    expect(hasMermaidSvg).toBe(true)
    
    console.log('=== All checks passed ===')
  })
})
