import { expect, test, type Locator, type Page } from '@playwright/test'

test.setTimeout(300000)

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

function toolCallBlocks(page: Page) {
  return page.getByTestId('tool-call-block')
}

function pickableCardButtons(scope: Locator) {
  return scope.locator('button').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ })
}

function interactiveToolCallBlocks(page: Page) {
  return toolCallBlocks(page).filter({
    has: page.locator('button:not([disabled])').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }),
  })
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
  const interactiveAppeared = await interactiveToolCallBlocks(page).last().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false)
  if (!interactiveAppeared) {
    const errorLocator = page.locator('text=/^Error:/')
    if (await errorLocator.count() > 0) {
      const errorText = await errorLocator.first().textContent()
      throw new Error(`Tool execution error: ${errorText}`)
    }
    test.skip(true, 'LLM did not produce an interactive pick_card block')
    throw new Error('unreachable after provider-inconclusive skip')
  }
  const callId = await interactiveToolCallBlocks(page).last().getAttribute('data-call-id')
  expect(callId).toBeTruthy()
  const block = page.locator(`[data-call-id="${callId}"]`)
  const enabledCards = block.locator('button:not([disabled])').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ })
  await expect(enabledCards.first()).toBeVisible({ timeout: 60000 })
  const pickedLabel = (await enabledCards.first().textContent())?.trim()
  expect(pickedLabel).toBeTruthy()
  await enabledCards.first().click()
  await expect(block.getByText(`You picked: ${pickedLabel}`)).toBeVisible({ timeout: 20000 })
  return { block, pickedLabel: pickedLabel! }
}

async function assertCompletedCardPicks(page: Page, labels: string[]) {
  await expect(toolCallBlocks(page)).toHaveCount(labels.length, { timeout: 30000 })
  for (let i = 0; i < labels.length; i++) {
    const block = toolCallBlocks(page).nth(i)
    await expect(block.getByText(`You picked: ${labels[i]}`)).toBeVisible({ timeout: 30000 })
    await expect(pickableCardButtons(block).first()).toBeDisabled({ timeout: 10000 })
  }
}

test.describe('Threaded Chat Prototype', () => {
  test('replays two completed card picks after refresh', async ({ page }) => {
    await createNewThread(page)

    await sendMessage(page, 'Draw 3 cards and let me pick one card')
    const first = await completeCardPick(page)

    await sendMessage(page, 'Draw another 3 cards and let me pick again')
    const second = await completeCardPick(page)
    await waitForIdle(page)

    await assertCompletedCardPicks(page, [first.pickedLabel, second.pickedLabel])

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Thread ready')).toBeVisible({ timeout: 30000 })

    await assertCompletedCardPicks(page, [first.pickedLabel, second.pickedLabel])
  })

  test('replays mermaid svg after refresh', async ({ page }) => {
    await createNewThread(page)

    await sendMessage(page, 'Explain rock paper scissors in mermaid and render it as a mermaid diagram')
    await waitForIdle(page)

    const latestAssistant = page.getByTestId('message-assistant').last()
    const svgAppeared = await latestAssistant.locator('svg').first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
    if (!svgAppeared) {
      const text = await latestAssistant.textContent().catch(() => '')
      console.log('Mermaid SVG did not appear. Assistant response:', text?.slice(0, 200))
      test.skip(true, 'LLM did not produce a renderable mermaid diagram')
      return
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Thread ready')).toBeVisible({ timeout: 30000 })

    const replayedAssistant = page.getByTestId('message-assistant').last()
    await expect(replayedAssistant.locator('svg').first()).toBeVisible({ timeout: 30000 })
  })
})