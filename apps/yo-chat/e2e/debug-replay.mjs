import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const toolBlockLogs = []
page.on('console', (msg) => {
  if (msg.text().includes('[ToolCallBlock]')) {
    toolBlockLogs.push(msg.text())
  }
})

await page.goto('http://localhost:8000/chat/threaded/', { waitUntil: 'domcontentloaded' })
await page.getByText('Thread ready', { timeout: 10000 }).waitFor()
await page.getByTestId('thread-create').click()
await page.getByText('Active').waitFor()

async function pickCard(page) {
  const blocks = page.getByTestId('tool-call-block')
  const interactive = blocks.filter({ has: page.locator('button:not([disabled])').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }) })
  await interactive.last().waitFor({ timeout: 60000 })
  const callId = await interactive.last().getAttribute('data-call-id')
  const block = page.locator(`[data-call-id="${callId}"]`)
  const card = block.locator('button:not([disabled])').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }).first()
  await card.waitFor({ timeout: 60000 })
  const label = await card.textContent()
  await card.click()
  await block.getByText(`You picked: ${label?.trim()}`).waitFor({ timeout: 20000 })
  return label?.trim()
}

async function send(page, text) {
  const input = page.getByPlaceholder('Ask this thread to draw a card...')
  await input.click()
  await input.fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

// Turn 1
await send(page, 'Draw 3 cards and let me pick one card')
const first = await pickCard(page)
console.log('First pick:', first)
await page.getByText('Thread ready', { timeout: 60000 }).waitFor()

// Turn 2
await send(page, 'Draw another 3 cards and let me pick again')
const second = await pickCard(page)
console.log('Second pick:', second)
await page.getByText('Thread ready', { timeout: 60000 }).waitFor()

// Pre-refresh logs
console.log('\n=== PRE-REFRESH TOOL BLOCK LOGS ===')
for (const log of toolBlockLogs) {
  console.log(log)
}

// Clear logs for refresh
toolBlockLogs.length = 0

// Refresh
await page.reload({ waitUntil: 'domcontentloaded' })
await page.getByText('Thread ready', { timeout: 30000 }).waitFor()

// Wait for rehydration
await page.waitForTimeout(3000)

// Post-refresh logs
console.log('\n=== POST-REFRESH TOOL BLOCK LOGS ===')
for (const log of toolBlockLogs) {
  console.log(log)
}

const blockCount = await page.getByTestId('tool-call-block').count()
console.log('\nTool blocks after refresh:', blockCount)

for (let i = 0; i < blockCount; i++) {
  const block = page.getByTestId('tool-call-block').nth(i)
  const text = await block.textContent()
  const callId = await block.getAttribute('data-call-id')
  console.log(`  Block #${i} callId=${callId}: ${(text || '').substring(0, 200)}`)
}

await browser.close()