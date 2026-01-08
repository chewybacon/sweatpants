import { test } from '@playwright/test'

/**
 * Exploration tests to understand the MCP Inspector UI structure.
 * 
 * Run with: pnpm test:headed
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
  
  // Wait for connection
  await page.waitForTimeout(2000)
}

test.describe('MCP Inspector UI Exploration', () => {
  
  test('connect and list tools', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    await page.screenshot({ path: 'test-results/01-initial-load.png', fullPage: true })
    
    // Connect to server
    await connectToServer(page)
    
    await page.screenshot({ path: 'test-results/02-after-connect.png', fullPage: true })
    
    // Check connection status
    const bodyText = await page.locator('body').textContent()
    console.log('Body after connect:', bodyText?.slice(0, 1000))
    
    const isConnected = bodyText?.includes('Connected') || bodyText?.includes('mcp-durable-runtime')
    console.log('Is connected:', isConnected)
    
    if (!isConnected) {
      console.log('Connection failed, checking for errors...')
      await page.screenshot({ path: 'test-results/02b-connection-failed.png', fullPage: true })
      return
    }
    
    // Click "List Tools" button
    const listToolsButton = page.getByRole('button', { name: 'List Tools' })
    if (await listToolsButton.isVisible()) {
      console.log('Clicking List Tools button...')
      await listToolsButton.click()
      await page.waitForTimeout(2000)
    }
    
    await page.screenshot({ path: 'test-results/03-after-list-tools.png', fullPage: true })
    
    // Check for tools
    const bodyTextAfter = await page.locator('body').textContent()
    console.log('Body after list tools:', bodyTextAfter?.slice(0, 1500))
    
    const hasEcho = bodyTextAfter?.includes('echo')
    const hasGreet = bodyTextAfter?.includes('greet')
    const hasPickCard = bodyTextAfter?.includes('pick_card')
    
    console.log('Has echo tool:', hasEcho)
    console.log('Has greet tool:', hasGreet)
    console.log('Has pick_card tool:', hasPickCard)
    
    // If tools are listed, try clicking on one
    if (hasEcho) {
      console.log('Found echo tool, looking for it in the UI...')
      const echoInList = page.getByText('echo').first()
      if (await echoInList.isVisible()) {
        await echoInList.click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: 'test-results/04-echo-selected.png', fullPage: true })
      }
    }
  })

  test('explore tool detail view', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    // Connect to server
    await connectToServer(page)
    
    // Wait a bit for tools to auto-load (or click list)
    await page.waitForTimeout(1000)
    
    const listToolsButton = page.getByRole('button', { name: 'List Tools' })
    if (await listToolsButton.isVisible()) {
      await listToolsButton.click()
      await page.waitForTimeout(2000)
    }
    
    // Look for tools in the sidebar/list
    const toolsInBody = await page.locator('body').textContent()
    console.log('Tools visible:', toolsInBody?.includes('echo'), toolsInBody?.includes('greet'))
    
    await page.screenshot({ path: 'test-results/05-tools-loaded.png', fullPage: true })
    
    // Try to find tool items - they might be in a list
    const toolItems = await page.locator('[class*="tool"], [data-tool]').all()
    console.log('Tool items found:', toolItems.length)
    
    // Look for buttons that might be tool entries
    const buttons = await page.getByRole('button').all()
    for (const btn of buttons.slice(0, 15)) {
      const text = await btn.textContent()
      if (text?.includes('echo') || text?.includes('greet') || text?.includes('pick')) {
        console.log('Found tool button:', text)
      }
    }
  })

  test('dump DOM structure after connection', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    // Connect
    await connectToServer(page)
    
    // List tools
    const listToolsButton = page.getByRole('button', { name: 'List Tools' })
    if (await listToolsButton.isVisible()) {
      await listToolsButton.click()
      await page.waitForTimeout(2000)
    }
    
    // Get DOM structure
    const html = await page.locator('body').innerHTML()
    
    const fs = await import('fs')
    fs.writeFileSync('test-results/dom-structure.html', html)
    console.log('DOM structure written to test-results/dom-structure.html')
    
    await page.screenshot({ path: 'test-results/06-full-connected.png', fullPage: true })
  })
})
