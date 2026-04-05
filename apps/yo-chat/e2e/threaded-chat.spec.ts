import { expect, test, type Locator, type Page } from '@playwright/test'

test.setTimeout(240000)

async function createNewThread(page: Page) {
  await page.goto('/chat/threaded/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Threaded Chat' })).toBeVisible()
  await expect(page.getByText('Thread ready')).toBeVisible({ timeout: 10000 })
  await page.getByTestId('thread-create').click()
  await expect(page.getByText('Active')).toBeVisible()
}

function threadInput(page: Page) {
  return page.getByPlaceholder('Ask this thread to draw a card...')
}

function assistantMessages(page: Page) {
  return page.getByTestId('message-assistant')
}

function toolCallBlocks(page: Page) {
  return page.getByTestId('tool-call-block')
}

function pickableCardButtons(scope: Locator) {
  return scope.locator('button').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ })
}

async function sendMessage(page: Page, text: string) {
  const input = threadInput(page)
  await input.click()
  await input.fill(text)
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 })
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForIdle(page: Page) {
  await expect(page.getByText('Thread ready')).toBeVisible({ timeout: 60000 })
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60000 })
}

async function completeCardPick(page: Page) {
  await expect(toolCallBlocks(page).last()).toBeVisible({ timeout: 60000 })
  const latestBlock = toolCallBlocks(page).last()
  const cards = pickableCardButtons(latestBlock)
  await expect(cards.first()).toBeVisible({ timeout: 60000 })
  const pickedLabel = (await cards.first().textContent())?.trim()
  expect(pickedLabel).toBeTruthy()
  await cards.first().click()
  await expect(latestBlock.getByText(`You picked: ${pickedLabel}`)).toBeVisible({ timeout: 20000 })
  return { latestBlock, pickedLabel: pickedLabel! }
}

test.describe('Threaded Chat Prototype', () => {
  test('replays two completed card picks after refresh', async ({ page }) => {
    await createNewThread(page)

    await sendMessage(page, 'Draw 3 cards and let me pick one card')
    const first = await completeCardPick(page)

    await sendMessage(page, 'Draw another 3 cards and let me pick again')
    const second = await completeCardPick(page)
    await waitForIdle(page)

    await expect(toolCallBlocks(page)).toHaveCount(2)
    await expect(toolCallBlocks(page).nth(0).getByText(`You picked: ${first.pickedLabel}`)).toBeVisible()
    await expect(toolCallBlocks(page).nth(1).getByText(`You picked: ${second.pickedLabel}`)).toBeVisible()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Threaded Chat' })).toBeVisible()
    await expect(page.getByText('Thread ready')).toBeVisible({ timeout: 30000 })

    await expect(toolCallBlocks(page)).toHaveCount(2, { timeout: 30000 })

    const replayedFirst = toolCallBlocks(page).nth(0)
    const replayedSecond = toolCallBlocks(page).nth(1)

    await expect(replayedFirst.getByText(`You picked: ${first.pickedLabel}`)).toBeVisible({ timeout: 30000 })
    await expect(replayedSecond.getByText(`You picked: ${second.pickedLabel}`)).toBeVisible({ timeout: 30000 })

    await expect(pickableCardButtons(replayedFirst).first()).toBeDisabled()
    await expect(pickableCardButtons(replayedSecond).first()).toBeDisabled()
  })

  test('replays mermaid svg after refresh', async ({ page }) => {
    await createNewThread(page)

    await sendMessage(page, 'Explain rock paper scissors in mermaid and render it as a mermaid diagram')
    await waitForIdle(page)

    const latestAssistant = assistantMessages(page).last()
    await expect(latestAssistant.locator('svg').first()).toBeVisible({ timeout: 30000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Threaded Chat' })).toBeVisible()
    await expect(page.getByText('Thread ready')).toBeVisible({ timeout: 30000 })

    const replayedAssistant = assistantMessages(page).last()
    await expect(replayedAssistant.locator('svg').first()).toBeVisible({ timeout: 30000 })
  })
})
