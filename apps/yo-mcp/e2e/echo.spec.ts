import { test, expect } from '@playwright/test'

/**
 * E2E tests for the echo tool.
 * 
 * The echo tool is the simplest tool - no backchannel (sampling or elicitation).
 * It just echoes back the input message with optional uppercase transform.
 */

// Helper to connect to server
async function connectToServer(page: import('@playwright/test').Page) {
  // Select Streamable HTTP transport
  const transportDropdown = page.locator('#transport-type-select')
  await transportDropdown.click()
  await page.waitForTimeout(300)
  
  const httpOption = page.getByRole('option', { name: 'Streamable HTTP' })
  await httpOption.click()
  await page.waitForTimeout(300)
  
  // Set the URL
  const urlInput = page.getByLabel(/url/i).first()
  await urlInput.clear()
  await urlInput.fill('http://localhost:3001/mcp')
  
  // Click Connect
  const connectButton = page.getByRole('button', { name: /connect/i })
  await connectButton.click()
  
  // Wait for connection indicator
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 })
}

// Helper to list tools (click List Tools button if needed)
async function ensureToolsListed(page: import('@playwright/test').Page) {
  const listToolsButton = page.getByRole('button', { name: 'List Tools' })
  if (await listToolsButton.isEnabled()) {
    await listToolsButton.click()
    await page.waitForTimeout(1000)
  }
}

// Helper to click on a tool in the list
async function selectTool(page: import('@playwright/test').Page, toolName: string) {
  // Tools are in a list with this structure
  const toolItem = page.locator('.cursor-pointer').filter({ hasText: toolName }).first()
  await toolItem.click()
  await page.waitForTimeout(500)
}

test.describe('Echo Tool', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await connectToServer(page)
    await ensureToolsListed(page)
  })

  test('echoes back a simple message', async ({ page }) => {
    // Select the echo tool
    await selectTool(page, 'echo')
    
    await page.screenshot({ path: 'test-results/echo-01-selected.png', fullPage: true })
    
    // The right panel should show the tool form
    // Look for the message input field
    const messageInput = page.getByLabel(/message/i).first()
    await expect(messageInput).toBeVisible({ timeout: 5000 })
    
    // Fill in the message
    await messageInput.fill('Hello, MCP!')
    
    await page.screenshot({ path: 'test-results/echo-02-filled.png', fullPage: true })
    
    // Click Run/Execute button
    const runButton = page.getByRole('button', { name: /run/i }).first()
    await runButton.click()
    
    // Wait for result to appear
    await page.waitForTimeout(2000)
    
    await page.screenshot({ path: 'test-results/echo-03-result.png', fullPage: true })
    
    // Check that the result contains our echoed message
    const bodyText = await page.locator('body').textContent()
    expect(bodyText).toContain('Hello, MCP!')
    expect(bodyText).toContain('echoed')
  })

  test('echoes back message in uppercase when flag is set', async ({ page }) => {
    // Select the echo tool
    await selectTool(page, 'echo')
    
    // Fill in the message
    const messageInput = page.getByLabel(/message/i).first()
    await expect(messageInput).toBeVisible({ timeout: 5000 })
    await messageInput.fill('hello world')
    
    // Find and check the uppercase checkbox
    const uppercaseCheckbox = page.getByLabel(/uppercase/i)
    if (await uppercaseCheckbox.isVisible()) {
      await uppercaseCheckbox.check()
    } else {
      // Try to find a toggle/switch
      const uppercaseToggle = page.locator('[role="switch"]').filter({ hasText: /uppercase/i })
      if (await uppercaseToggle.isVisible()) {
        await uppercaseToggle.click()
      }
    }
    
    await page.screenshot({ path: 'test-results/echo-uppercase-01-filled.png', fullPage: true })
    
    // Click Run
    const runButton = page.getByRole('button', { name: /run/i }).first()
    await runButton.click()
    
    await page.waitForTimeout(2000)
    
    await page.screenshot({ path: 'test-results/echo-uppercase-02-result.png', fullPage: true })
    
    // Check that the result contains uppercase message
    const bodyText = await page.locator('body').textContent()
    expect(bodyText).toContain('HELLO WORLD')
  })

  test('shows length in result', async ({ page }) => {
    // Select the echo tool
    await selectTool(page, 'echo')
    
    // Fill in a known-length message
    const messageInput = page.getByLabel(/message/i).first()
    await expect(messageInput).toBeVisible({ timeout: 5000 })
    await messageInput.fill('12345')
    
    // Click Run
    const runButton = page.getByRole('button', { name: /run/i }).first()
    await runButton.click()
    
    await page.waitForTimeout(2000)
    
    await page.screenshot({ path: 'test-results/echo-length-result.png', fullPage: true })
    
    // Check that length is shown (should be 5)
    const bodyText = await page.locator('body').textContent()
    expect(bodyText).toContain('12345')
    expect(bodyText).toContain('5') // length
  })
})
