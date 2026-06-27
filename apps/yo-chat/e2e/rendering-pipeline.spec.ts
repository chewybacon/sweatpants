import { test, expect, type Page, type Locator } from '@playwright/test'

test.setTimeout(120000)

async function openRenderingFixture(page: Page) {
  await page.goto('/chat/basic/?scriptedRendering=1', { waitUntil: 'networkidle' })
  await page.evaluate(() => window.localStorage.removeItem('basic-chat-scripted-rendering-conversation-id'))
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Basic Chat' })).toBeVisible()
  await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 30000 })
  await page.getByPlaceholder('Type a message...').click()
}

async function sendFixture(page: Page, prompt: string, expectedMessageCount: number) {
  const input = page.getByPlaceholder('Type a message...')
  await input.fill(prompt)
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 5000 })
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(`${expectedMessageCount} messages`)).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('streaming...')).not.toBeVisible({ timeout: 30000 })
}

function assistantMessages(page: Page): Locator {
  return page.locator('.bg-slate-800\\/50')
}

test.describe('deterministic rendering pipeline e2e', () => {
  test('renders streamed markdown in the browser', async ({ page }) => {
    await openRenderingFixture(page)
    await sendFixture(page, 'render markdown fixture', 2)

    const assistant = assistantMessages(page).first()
    await expect(assistant.locator('h1')).toContainText('Rendering fixture')
    await expect(assistant.locator('em')).toContainText('italic text')
    await expect(assistant.locator('strong')).toContainText('bold text')
    await expect(assistant.locator('li')).toHaveCount(2)
    await expect(assistant).not.toContainText('**bold text**')
  })

  test('renders streamed inline and block math with KaTeX', async ({ page }) => {
    await openRenderingFixture(page)
    await sendFixture(page, 'render math fixture', 2)

    const assistant = assistantMessages(page).first()
    await expect(assistant.locator('h1')).toContainText('Math fixture')
    await expect(assistant.locator('.katex').first()).toBeVisible({ timeout: 30000 })
    await expect(assistant.locator('.katex-display').first()).toBeVisible({ timeout: 30000 })
    await expect(assistant).not.toContainText('$$')
  })

  test('renders streamed mermaid diagrams as SVG', async ({ page }) => {
    await openRenderingFixture(page)
    await sendFixture(page, 'render mermaid fixture', 2)

    const assistant = assistantMessages(page).first()
    await expect(assistant.locator('h1')).toContainText('Mermaid fixture')
    await expect(assistant.locator('.mermaid-diagram svg').first()).toBeVisible({ timeout: 30000 })
    await expect(assistant).not.toContainText('```mermaid')
  })

  test('preserves rendered markdown, math, and mermaid across multiple turns', async ({ page }) => {
    await openRenderingFixture(page)

    await sendFixture(page, 'render markdown fixture', 2)
    await sendFixture(page, 'render math fixture', 4)
    await sendFixture(page, 'render mermaid fixture', 6)

    const assistants = assistantMessages(page)
    await expect(assistants).toHaveCount(3)

    const markdown = assistants.nth(0)
    const math = assistants.nth(1)
    const mermaid = assistants.nth(2)

    await expect(markdown.locator('h1')).toContainText('Rendering fixture')
    await expect(markdown.locator('strong')).toContainText('bold text')
    await expect(markdown.locator('li')).toHaveCount(2)

    await expect(math.locator('h1')).toContainText('Math fixture')
    await expect(math.locator('.katex').first()).toBeVisible({ timeout: 30000 })
    await expect(math.locator('.katex-display').first()).toBeVisible({ timeout: 30000 })

    await expect(mermaid.locator('h1')).toContainText('Mermaid fixture')
    await expect(mermaid.locator('.mermaid-diagram svg').first()).toBeVisible({ timeout: 30000 })

    await expect(markdown).not.toContainText('**bold text**')
    await expect(math).not.toContainText('$$')
    await expect(mermaid).not.toContainText('```mermaid')
  })
})
