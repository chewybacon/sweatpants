import { expect, test, type Page } from '@playwright/test'

test.setTimeout(180000)

function cardButton(page: Page) {
  return page.locator('button').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }).first()
}

test.describe('Threaded Chat Prototype', () => {
  test.fixme('persists a picked card across refresh and allows continuing the same thread', async ({ page }) => {
    await page.goto('/chat/threaded/', { waitUntil: 'networkidle' })

    await expect(page.getByRole('heading', { name: 'Threaded Chat' })).toBeVisible()
    const input = page.getByPlaceholder('Ask this thread to draw a card...')
    await expect(input).toBeVisible()
    await input.click()

    const initialThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(initialThreadId).toBeTruthy()

    await input.fill('Use the pick_card tool with count=3 and let me choose a card')
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 })
    await page.getByRole('button', { name: 'Send' }).click()

    const firstCard = cardButton(page)
    await expect(firstCard).toBeVisible({ timeout: 60000 })
    const pickedLabel = (await firstCard.textContent())?.trim()
    expect(pickedLabel).toBeTruthy()

    await firstCard.click()
    await expect(page.getByText(`You picked: ${pickedLabel}`)).toBeVisible({ timeout: 15000 })

    await page.reload({ waitUntil: 'networkidle' })

    await expect(page.locator('text=/^[0-9a-f-]{36}$/i').first()).toHaveText(initialThreadId ?? '')
    await expect(page.getByText(`You picked: ${pickedLabel}`)).toBeVisible({ timeout: 15000 })

    const refreshedCard = cardButton(page)
    await expect(refreshedCard).toBeVisible()
    await expect(refreshedCard).toBeDisabled()

    const secondInput = page.getByPlaceholder('Ask this thread to draw a card...')
    await secondInput.click()
    await secondInput.fill('Draw another card for me with count=3')
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 })
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(async () => {
      const count = await page.locator('text=/You picked:/').count()
      expect(count).toBeGreaterThanOrEqual(2)
    }).toPass({ timeout: 60000 })
  })

  test('creates a new thread and keeps the older thread in the sidebar', async ({ page }) => {
    await page.goto('/chat/threaded/', { waitUntil: 'networkidle' })

    const initialCount = await page.getByTestId('thread-item').count()
    const firstThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(firstThreadId).toBeTruthy()

    await page.getByTestId('thread-create').click()

    const secondThreadId = await page.locator('text=/^[0-9a-f-]{36}$/i').first().textContent()
    expect(secondThreadId).toBeTruthy()
    expect(secondThreadId).not.toBe(firstThreadId)

    await expect(page.getByTestId('thread-item')).toHaveCount(initialCount + 1)
  })
})
