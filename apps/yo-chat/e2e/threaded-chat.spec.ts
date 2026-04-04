import { expect, test } from '@playwright/test'

test.describe('Threaded Chat Prototype', () => {
  test('can create a thread, send a message, and keep it after refresh', async ({ page }) => {
    await page.goto('/chat/threaded/', { waitUntil: 'networkidle' })

    await expect(page.getByRole('heading', { name: 'Threaded Chat' })).toBeVisible()
    await expect(page.getByPlaceholder('Send a message to the current durable thread...')).toBeVisible()

    const initialThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(initialThreadId).toBeTruthy()

    await page
      .getByPlaceholder('Send a message to the current durable thread...')
      .fill('Say exactly: durable threaded hello')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText('durable threaded hello').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/Assistant/i)).toBeVisible({ timeout: 60000 })

    await page.reload({ waitUntil: 'networkidle' })

    await expect(page.getByText('durable threaded hello').first()).toBeVisible({ timeout: 10000 })
    const refreshedThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(refreshedThreadId).toBe(initialThreadId)
  })

  test('new thread creates a different thread id and keeps older thread in sidebar', async ({ page }) => {
    await page.goto('/chat/threaded/', { waitUntil: 'networkidle' })

    const firstThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(firstThreadId).toBeTruthy()

    await page.getByRole('button', { name: 'New thread' }).click()

    const secondThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(secondThreadId).toBeTruthy()
    expect(secondThreadId).not.toBe(firstThreadId)

    const threadButtons = page.locator('aside button')
    await expect(threadButtons).toHaveCount(3)
  })
})
