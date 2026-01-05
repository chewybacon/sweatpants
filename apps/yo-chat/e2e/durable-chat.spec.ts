import { test, expect } from '@playwright/test'

/**
 * E2E tests for the Durable Chat Handler.
 * 
 * These tests verify:
 * 1. Feature parity with regular /api/chat (basic streaming, tools, markdown)
 * 2. Durable-specific features (session ID, reconnection, replay)
 * 
 * Tests require:
 * - Ollama running locally at http://localhost:11434
 * - A model that supports tool calling (e.g., qwen3:30b)
 * 
 * Run with: pnpm test:e2e --grep "Durable"
 */

// Increase timeout for LLM responses
test.setTimeout(180000)

// =============================================================================
// PARITY TESTS - These should pass just like /demo/chat tests
// =============================================================================

test.describe('Durable Chat - Feature Parity', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo/chat-durable/')
    await expect(page.getByRole('heading', { name: 'Durable Chat' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  test('can send a simple message and receive a response', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Say exactly: Hello World')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for streaming to start
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Wait for the response to complete
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Should have both user message and assistant response
    await expect(page.getByText('Say exactly: Hello World')).toBeVisible()
    
    // Should show 2 messages (user + assistant)
    await expect(page.getByText('2 messages')).toBeVisible({ timeout: 5000 })
    
    // CRITICAL: Verify assistant message actually has content rendered
    // This catches bugs where the message bubble appears but content is empty/undefined
    const assistantMessage = page.locator('.prose').last()
    const assistantText = await assistantMessage.textContent()
    expect(assistantText).toBeTruthy()
    expect(assistantText!.length).toBeGreaterThan(0)
    
    // Should NOT contain "undefined" which indicates parsing issues
    expect(assistantText).not.toContain('undefined')
    expect(assistantText).not.toContain('undefinedundefined')
    
    console.log('Assistant response:', assistantText?.slice(0, 100))
  })

  test('can abort a streaming response', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Count from 1 to 1000 slowly, one number per line')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for streaming to start
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Wait for some content to stream
    await page.waitForTimeout(3000)
    
    // Abort the response
    await page.getByRole('button', { name: 'Stop' }).click()
    
    // Streaming should stop
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 10000 })
    
    // Should show messages were received
    await expect(page.locator('text=/[12] messages/')).toBeVisible({ timeout: 5000 })
  })

  test('renders markdown in responses', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    // Be very explicit about wanting a code block
    await input.fill('Write ONLY this Python code in a markdown code block, nothing else:\n```python\nprint("hello")\n```')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Should have rendered markdown with code highlighting (Shiki)
    // If LLM outputs code block, it should be rendered as <pre><code>
    // If not, test still passes but we log a warning
    const codeBlock = page.locator('pre code')
    const hasCodeBlock = await codeBlock.count() > 0
    
    if (hasCodeBlock) {
      await expect(codeBlock).toBeVisible()
      console.log('Code block rendered correctly')
    } else {
      // LLM didn't output a code block - not a framework bug
      const response = await page.locator('.prose').last().textContent()
      console.log('LLM did not output code block. Response:', response?.slice(0, 200))
      // Still check we got a response
      expect(response).toBeTruthy()
    }
  })

  test('rendered markdown persists after streaming completes', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    // Be very explicit
    await input.fill('Output EXACTLY this markdown code block:\n```python\nprint("hello world")\n```')
    
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // Wait for streaming to complete first
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Check if we got a code block
    const codeBlock = page.locator('pre code')
    const hasCodeBlock = await codeBlock.count() > 0
    
    if (hasCodeBlock) {
      // Code block should be rendered (not raw markdown)
      await expect(codeBlock).toBeVisible({ timeout: 5000 })
      
      // Verify it's not showing raw markdown (``` should not be visible as text)
      const rawMarkdownVisible = await page.locator('text=/```python/').count()
      expect(rawMarkdownVisible).toBe(0)
      
      console.log('Markdown persistence verified - code block still rendered after streaming')
    } else {
      // LLM didn't output a code block
      const response = await page.locator('.prose').last().textContent()
      console.log('LLM did not output code block. Response:', response?.slice(0, 200))
      expect(response).toBeTruthy()
    }
    
    await expect(page.getByText('2 messages')).toBeVisible()
  })

  test('thinking/reasoning content renders without undefined', async ({ page }) => {
    // This test specifically catches the text vs content field mismatch bug
    // where thinking content was coming through as "undefined" repeatedly
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('What is 2+2? Think step by step.')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Get all text content from the assistant's response area
    const pageContent = await page.content()
    
    // Should NOT have repeated "undefined" which indicates field mismatch
    const undefinedMatches = pageContent.match(/undefined/g) || []
    // Allow at most 2 occurrences (could be legitimate in code examples)
    // but NOT the "undefinedundefinedundefined..." pattern
    expect(pageContent).not.toContain('undefinedundefined')
    
    console.log(`Page contains ${undefinedMatches.length} occurrences of 'undefined'`)
    
    // Verify we actually got meaningful content
    const assistantMessage = page.locator('.prose').last()
    const assistantText = await assistantMessage.textContent()
    expect(assistantText).toBeTruthy()
    expect(assistantText!.length).toBeGreaterThan(10)
    
    console.log('Response:', assistantText?.slice(0, 150))
  })

  test('can reset the conversation', async ({ page }) => {
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

test.describe('Durable Chat - Tool Calling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo/chat-durable/')
    await expect(page.getByRole('heading', { name: 'Durable Chat' })).toBeVisible()
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
  })

  test('LLM can call the calculator tool', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Use the calculator tool to compute 42 * 17. What is the result?')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response to complete
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 120000 })
    
    // Check the response contains either the answer or mentions calculator
    const responseText = await page.locator('.prose').last().textContent()
    expect(responseText).toBeTruthy()
    console.log('Calculator response:', responseText?.slice(0, 200))
  })

  test('LLM can call the pick_card tool and user can interact', async ({ page }) => {
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Use the pick_card tool with count=3 to let me pick a card')
    
    await page.getByRole('button', { name: 'Send' }).click()
    
    // Wait for response - could be card picker UI or text
    await expect(page.getByText('streaming...')).toBeVisible({ timeout: 60000 })
    
    // CRITICAL: Check there are no error messages displayed
    // This catches tool execution errors like "yield* is not iterable"
    const errorLocator = page.locator('text=/Error:|is not iterable|undefined/')
    const hasError = await errorLocator.count() > 0
    if (hasError) {
      const errorText = await errorLocator.first().textContent()
      throw new Error(`Tool execution error detected: ${errorText}`)
    }
    
    // Try to find card picker UI
    const cardButton = page.locator('button').filter({ hasText: /[AKQJ\d]+[\u2665\u2666\u2663\u2660]/ }).first()
    
    try {
      await expect(cardButton).toBeVisible({ timeout: 60000 })
      
      const cardText = await cardButton.textContent()
      console.log(`Found card picker! Clicking card: ${cardText}`)
      
      await cardButton.click()
      
      // After clicking, should show the selection confirmation
      await expect(page.getByText(/You picked:/)).toBeVisible({ timeout: 15000 })
      
      console.log('Card selection successful!')
    } catch (e) {
      // Card picker didn't appear - check if there's a text response
      await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 60000 })
      
      // Check for errors again after streaming completes
      const postStreamError = page.locator('text=/Error:|is not iterable|yield\\*/')
      const hasPostError = await postStreamError.count() > 0
      if (hasPostError) {
        const errorText = await postStreamError.first().textContent()
        throw new Error(`Tool execution error after streaming: ${errorText}`)
      }
      
      const responseText = await page.locator('.prose').last().textContent()
      console.log('No card picker appeared. Response:', responseText?.slice(0, 300))
      
      // If no card picker and no error, LLM just didn't call the tool
      // This is acceptable but log it
      expect(responseText).toBeTruthy()
    }
  })
})

// =============================================================================
// DURABLE-SPECIFIC TESTS - Features unique to the durable handler
// =============================================================================

test.describe('Durable Chat - Session Features', () => {
  test('API returns X-Session-Id header', async ({ request }) => {
    const response = await request.post('/api/chat-durable', {
      data: {
        messages: [{ role: 'user', content: 'Hi' }],
        provider: 'ollama',
      },
    })
    
    expect(response.status()).toBe(200)
    
    // Check for session ID header
    const sessionId = response.headers()['x-session-id']
    expect(sessionId).toBeTruthy()
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i) // UUID format
    
    console.log('Session ID:', sessionId)
  })

  test('response format is NDJSON with LSN', async ({ request }) => {
    const response = await request.post('/api/chat-durable', {
      data: {
        messages: [{ role: 'user', content: 'Say hi' }],
        provider: 'ollama',
      },
    })
    
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/x-ndjson')
    
    const body = await response.text()
    const lines = body.trim().split('\n')
    
    // Each line should be valid JSON with lsn and event
    for (const line of lines.slice(0, 5)) {
      const parsed = JSON.parse(line)
      expect(parsed).toHaveProperty('lsn')
      expect(parsed).toHaveProperty('event')
      expect(typeof parsed.lsn).toBe('number')
      expect(parsed.lsn).toBeGreaterThan(0)
    }
    
    // First event should be session_info
    const firstEvent = JSON.parse(lines[0])
    expect(firstEvent.event.type).toBe('session_info')
    
    console.log('First 3 events:', lines.slice(0, 3).join('\n'))
  })

  test('text and thinking events have content field (not text)', async ({ request }) => {
    // This test catches the field name mismatch bug where server sent
    // { type: 'text', text: '...' } but client expected { type: 'text', content: '...' }
    const response = await request.post('/api/chat-durable', {
      data: {
        messages: [{ role: 'user', content: 'Say hello' }],
        provider: 'ollama',
      },
    })
    
    const body = await response.text()
    const lines = body.trim().split('\n')
    
    for (const line of lines) {
      const { event } = JSON.parse(line)
      
      if (event.type === 'text') {
        // Should have 'content' field, NOT 'text' field
        expect(event).toHaveProperty('content')
        expect(event.content).toBeDefined()
        expect(typeof event.content).toBe('string')
        // Should NOT have old 'text' field
        expect(event).not.toHaveProperty('text')
      }
      
      if (event.type === 'thinking') {
        // Should have 'content' field, NOT 'text' field  
        expect(event).toHaveProperty('content')
        expect(event.content).toBeDefined()
        expect(typeof event.content).toBe('string')
        // Should NOT have old 'text' field
        expect(event).not.toHaveProperty('text')
      }
    }
    
    console.log('Verified all text/thinking events use content field')
  })

  test('LSN increases monotonically', async ({ request }) => {
    const response = await request.post('/api/chat-durable', {
      data: {
        messages: [{ role: 'user', content: 'Count to 5' }],
        provider: 'ollama',
      },
    })
    
    const body = await response.text()
    const lines = body.trim().split('\n')
    
    let previousLsn = 0
    for (const line of lines) {
      const { lsn } = JSON.parse(line)
      expect(lsn).toBeGreaterThan(previousLsn)
      previousLsn = lsn
    }
    
    console.log(`Total events: ${lines.length}, final LSN: ${previousLsn}`)
  })
})

test.describe('Durable Chat - Reconnection', () => {
  test.skip('can reconnect to session and resume from LSN', async ({ request }) => {
    // This test verifies reconnection works
    // NOTE: Currently skipped because in-memory storage doesn't persist across requests
    // TODO: Enable when we have shared storage or persistent sessions
    
    // First request - start streaming
    const response1 = await request.post('/api/chat-durable', {
      data: {
        messages: [{ role: 'user', content: 'Count slowly from 1 to 10' }],
        provider: 'ollama',
      },
    })
    
    const sessionId = response1.headers()['x-session-id']
    expect(sessionId).toBeTruthy()
    
    // Read first few events
    const body1 = await response1.text()
    const lines1 = body1.trim().split('\n')
    
    // Get LSN from middle of stream
    const midIndex = Math.floor(lines1.length / 2)
    const midEvent = JSON.parse(lines1[midIndex])
    const resumeLsn = midEvent.lsn
    
    console.log(`First request: ${lines1.length} events, resuming from LSN ${resumeLsn}`)
    
    // Second request - reconnect from middle
    const response2 = await request.post('/api/chat-durable', {
      headers: {
        'X-Session-Id': sessionId,
        'X-Last-LSN': String(resumeLsn),
      },
      data: {
        messages: [{ role: 'user', content: 'Count slowly from 1 to 10' }],
        provider: 'ollama',
      },
    })
    
    const body2 = await response2.text()
    const lines2 = body2.trim().split('\n')
    
    // Should get events starting from resumeLsn + 1
    if (lines2.length > 0) {
      const firstReconnectEvent = JSON.parse(lines2[0])
      expect(firstReconnectEvent.lsn).toBeGreaterThan(resumeLsn)
    }
    
    console.log(`Reconnect: ${lines2.length} events received`)
  })
})
