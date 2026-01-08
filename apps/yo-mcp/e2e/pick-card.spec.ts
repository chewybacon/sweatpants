import { test, expect } from '@playwright/test'

/**
 * E2E tests for the pick_card tool.
 * 
 * The pick_card tool uses the elicitation backchannel to let the user pick a card.
 * When the tool runs, it draws random cards and sends an elicitation request to the client,
 * which should display a form in the Elicitations tab for the user to respond.
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
  const toolItem = page.locator('.cursor-pointer').filter({ hasText: toolName }).first()
  await toolItem.click()
  await page.waitForTimeout(500)
}

test.describe('Pick Card Tool (Elicitation)', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await connectToServer(page)
    await ensureToolsListed(page)
  })

  test('picks a card via elicitation backchannel', async ({ page }) => {
    // Capture console messages for debugging
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`Browser ${msg.type()}: ${msg.text()}`)
      }
    })
    
    // Select the pick_card tool
    await selectTool(page, 'pick_card')
    
    await page.screenshot({ path: 'test-results/pick-card-01-selected.png', fullPage: true })
    
    // Set count to 3 for simpler testing
    const countInput = page.getByLabel(/count/i)
    if (await countInput.isVisible()) {
      await countInput.clear()
      await countInput.fill('3')
    }
    
    await page.screenshot({ path: 'test-results/pick-card-02-filled.png', fullPage: true })
    
    // Click Run - this will trigger the elicitation request
    const runButton = page.getByRole('button', { name: /run/i }).first()
    await runButton.click()
    
    // Wait for the elicitation request to be sent
    await page.waitForTimeout(2000)
    
    await page.screenshot({ path: 'test-results/pick-card-03-after-run.png', fullPage: true })
    
    // The Elicitations tab should show a badge with "1" indicating pending request
    const elicitationsTab = page.getByRole('tab', { name: /elicitation/i })
    
    // Wait for badge to appear (indicates pending elicitation)
    await expect(elicitationsTab.locator('.absolute')).toBeVisible({ timeout: 10000 })
    
    await page.screenshot({ path: 'test-results/pick-card-04-elicitation-pending.png', fullPage: true })
    
    // Click on Elicitations tab
    await elicitationsTab.click()
    await page.waitForTimeout(500)
    
    await page.screenshot({ path: 'test-results/pick-card-05-elicitation-tab.png', fullPage: true })
    
    // The elicitation message should contain the card options
    // Format: "1. <rank> of <suit>\n2. <rank> of <suit>\n3. <rank> of <suit>"
    const bodyText = await page.locator('body').textContent() ?? ''
    console.log('Body after clicking elicitation tab:', bodyText.slice(0, 2000))
    
    // Extract the first card from the message using regex
    // The message format is "1. X of Y" where X is rank (2-10, J, Q, K, A) and Y is suit
    const cardMatch = bodyText.match(/1\.\s*(\w+)\s+of\s+(\w+)/i)
    expect(cardMatch).toBeTruthy()
    
    const firstCardRank = cardMatch![1]
    const firstCardSuit = cardMatch![2]
    const firstCardDescription = `${firstCardRank} of ${firstCardSuit}`
    console.log(`First card is: ${firstCardDescription}`)
    
    // Fill in the cardNumber field - pick card 1
    // The Inspector should render an input for cardNumber based on the JSON schema
    const cardNumberInput = page.getByRole('spinbutton').or(
      page.locator('input[type="number"]')
    ).first()
    
    await expect(cardNumberInput).toBeVisible({ timeout: 5000 })
    await cardNumberInput.fill('1')
    
    await page.screenshot({ path: 'test-results/pick-card-06-response-filled.png', fullPage: true })
    
    // Click Submit button to submit the elicitation response
    const submitButton = page.getByRole('button', { name: /submit/i })
    await expect(submitButton).toBeVisible()
    await submitButton.click()
    
    // Wait for the response to be processed
    await page.waitForTimeout(2000)
    
    await page.screenshot({ path: 'test-results/pick-card-07-after-approve.png', fullPage: true })
    
    // Go back to Tools tab to see the result
    const toolsTab = page.getByRole('tab', { name: /tools/i })
    await toolsTab.click()
    await page.waitForTimeout(1000)
    
    await page.screenshot({ path: 'test-results/pick-card-08-final-result.png', fullPage: true })
    
    // Verify the result contains the picked card
    const finalBodyText = await page.locator('body').textContent() ?? ''
    console.log('Final body text:', finalBodyText.slice(0, 2000))
    
    // The result should show "Tool Result: Success" and contain:
    // - "picked": "<rank> of <suit>" matching our first card
    // - "success": true
    expect(finalBodyText).toContain('Tool Result')
    expect(finalBodyText).toContain('success')
    expect(finalBodyText).toContain('true')
    expect(finalBodyText).toContain('picked')
    
    // Verify the picked card matches what we selected (card 1)
    expect(finalBodyText.toLowerCase()).toContain(firstCardDescription.toLowerCase())
  })

  test('handles declined elicitation', async ({ page }) => {
    // Capture console messages for debugging
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`Browser ${msg.type()}: ${msg.text()}`)
      }
    })
    
    // Select the pick_card tool
    await selectTool(page, 'pick_card')
    
    // Use default count (5)
    
    // Click Run
    const runButton = page.getByRole('button', { name: /run/i }).first()
    await runButton.click()
    
    await page.waitForTimeout(2000)
    
    // Wait for elicitation badge
    const elicitationsTab = page.getByRole('tab', { name: /elicitation/i })
    await expect(elicitationsTab.locator('.absolute')).toBeVisible({ timeout: 10000 })
    
    // Go to Elicitations tab
    await elicitationsTab.click()
    await page.waitForTimeout(500)
    
    await page.screenshot({ path: 'test-results/pick-card-decline-01-elicitation-tab.png', fullPage: true })
    
    // Click Decline button to decline the elicitation
    const declineButton = page.getByRole('button', { name: /decline/i })
    await expect(declineButton).toBeVisible()
    await declineButton.click()
    
    await page.waitForTimeout(2000)
    
    await page.screenshot({ path: 'test-results/pick-card-decline-02-after-reject.png', fullPage: true })
    
    // Go back to Tools tab
    const toolsTab = page.getByRole('tab', { name: /tools/i })
    await toolsTab.click()
    await page.waitForTimeout(1000)
    
    await page.screenshot({ path: 'test-results/pick-card-decline-03-final-result.png', fullPage: true })
    
    // The result should indicate no card was picked
    const finalBodyText = await page.locator('body').textContent() ?? ''
    console.log('Final body text after reject:', finalBodyText.slice(0, 2000))
    
    // Result should show success: false and "No card was picked"
    expect(finalBodyText).toContain('Tool Result')
    expect(finalBodyText).toContain('success')
    expect(finalBodyText).toContain('false')
    expect(finalBodyText.toLowerCase()).toMatch(/no card|not picked/i)
  })
})
