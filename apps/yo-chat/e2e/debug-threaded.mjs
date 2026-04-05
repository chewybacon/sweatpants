import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
page.on('request', (req) => {
  if (req.url().includes('/api/chat')) {
    console.log('[request]', req.method(), req.url(), req.postData())
  }
})
page.on('response', async (res) => {
  if (res.url().includes('/api/chat')) {
    let body = '<unavailable>'
    try {
      body = await res.text()
    } catch (error) {
      body = `[body read failed: ${error instanceof Error ? error.message : String(error)}]`
    }
    console.log('[response]', res.status(), res.url(), body)
  }
})

await page.goto('http://localhost:8000/chat/threaded/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const input = page.getByPlaceholder('Ask this thread to draw a card...')
console.log('thread id before send', await page.locator('[data-testid="thread-item"][aria-pressed="true"]').getAttribute('data-thread-id'))
console.log('window debug before send', await page.evaluate(() => (window).__threadedDebug))
await input.click()
await input.fill('hello threaded world')
console.log('send enabled', await page.getByRole('button', { name: 'Send' }).isEnabled())
await page.getByRole('button', { name: 'Send' }).click()
await page.waitForTimeout(5000)
console.log('--- after send ---')
console.log(await page.locator('body').innerText())
console.log('tool-call blocks after send', await page.getByTestId('tool-call-block').count())
console.log('assistant messages after send', await page.getByTestId('message-assistant').count())
console.log('window debug after send', await page.evaluate(() => (window).__threadedDebug))

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
console.log('--- after refresh ---')
console.log('thread id after refresh', await page.locator('[data-testid="thread-item"][aria-pressed="true"]').getAttribute('data-thread-id'))
console.log(await page.locator('body').innerText())
console.log('tool-call blocks after refresh', await page.getByTestId('tool-call-block').count())
console.log('assistant messages after refresh', await page.getByTestId('message-assistant').count())
console.log('window debug after refresh', await page.evaluate(() => (window).__threadedDebug))

await browser.close()
