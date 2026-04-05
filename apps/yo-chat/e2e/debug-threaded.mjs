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

await page.goto('http://localhost:8000/chat/threaded/', { waitUntil: 'networkidle' })
const input = page.getByPlaceholder('Ask this thread to draw a card...')
await input.click()
await input.fill('hello threaded world')
console.log('send enabled', await page.getByRole('button', { name: 'Send' }).isEnabled())
await page.getByRole('button', { name: 'Send' }).click()
await page.waitForTimeout(5000)
console.log(await page.locator('body').innerText())

await browser.close()
