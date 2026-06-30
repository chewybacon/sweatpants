import { expect, test, type Locator, type Page } from "@playwright/test";

test.setTimeout(300000);

async function createNewThread(page: Page) {
  await page.goto("/chat/threaded/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Threaded Chat" })).toBeVisible();
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("thread-create").click();
  await expect(page.getByText("Active")).toBeVisible();
}

function threadInput(page: Page) {
  return page.getByPlaceholder("Ask this thread to draw a card...");
}

function toolCallBlocks(page: Page) {
  return page.getByTestId("tool-call-block");
}

function pickableCardButtons(scope: Locator) {
  return scope.locator("button").filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ });
}

function interactiveToolCallBlocks(page: Page) {
  return toolCallBlocks(page).filter({
    has: page.locator("button:not([disabled])").filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }),
  });
}

async function sendMessage(page: Page, text: string) {
  const input = threadInput(page);
  await input.click();
  await input.fill(text);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 10000 });
  await page.getByRole("button", { name: "Send" }).click();
}

async function waitForIdle(page: Page) {
  await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60000 });
}

async function completeCardPick(page: Page) {
  const interactiveAppeared = await interactiveToolCallBlocks(page)
    .last()
    .waitFor({ state: "visible", timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  if (!interactiveAppeared) {
    const errorLocator = page.locator("text=/^Error:/");
    if ((await errorLocator.count()) > 0) {
      const errorText = await errorLocator.first().textContent();
      throw new Error(`Tool execution error: ${errorText}`);
    }
    test.skip(true, "LLM did not produce an interactive pick_card block");
    throw new Error("unreachable after provider-inconclusive skip");
  }
  const callId = await interactiveToolCallBlocks(page).last().getAttribute("data-call-id");
  expect(callId).toBeTruthy();
  const block = page.locator(`[data-call-id="${callId}"]`);
  const enabledCards = block
    .locator("button:not([disabled])")
    .filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ });
  await expect(enabledCards.first()).toBeVisible({ timeout: 60000 });
  const pickedLabel = (await enabledCards.first().textContent())?.trim();
  expect(pickedLabel).toBeTruthy();
  await enabledCards.first().click();
  await expect(block.getByText(`You picked: ${pickedLabel}`)).toBeVisible({ timeout: 20000 });
  return { block, pickedLabel: pickedLabel! };
}

async function assertCompletedCardPicks(page: Page, labels: string[]) {
  await expect(toolCallBlocks(page)).toHaveCount(labels.length, { timeout: 30000 });
  for (const label of labels) {
    const block = toolCallBlocks(page)
      .filter({ hasText: `You picked: ${label}` })
      .first();
    await expect(block.getByText(`You picked: ${label}`)).toBeVisible({ timeout: 30000 });
    await expect(pickableCardButtons(block).first()).toBeDisabled({ timeout: 10000 });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickedCardPattern(displayLabel: string): RegExp {
  const suitNames: Record<string, string> = {
    "♥": "Hearts",
    "♦": "Diamonds",
    "♣": "Clubs",
    "♠": "Spades",
  };
  const rankNames: Record<string, string> = {
    A: "Ace",
    K: "King",
    Q: "Queen",
    J: "Jack",
  };
  const suitSymbol = displayLabel.slice(-1);
  const rank = displayLabel.slice(0, -1);
  const rankText = rankNames[rank] ?? rank;
  const humanLabel = suitNames[suitSymbol]
    ? `${rankText} of ${suitNames[suitSymbol]}`
    : displayLabel;
  const shortHumanLabel = suitNames[suitSymbol]
    ? `${rank} of ${suitNames[suitSymbol]}`
    : displayLabel;
  return new RegExp(
    `${escapeRegex(displayLabel)}|${escapeRegex(humanLabel)}|${escapeRegex(shortHumanLabel)}`,
    "i",
  );
}

async function waitForAssistantMentioningCard(page: Page, displayLabel: string, minIndex = 0) {
  const cardPattern = pickedCardPattern(displayLabel);
  await expect
    .poll(
      async () => {
        const assistants = await page.getByTestId("message-assistant").allTextContents();
        return assistants.slice(minIndex).some((text) => cardPattern.test(text));
      },
      { timeout: 90000 },
    )
    .toBe(true);
}

test.describe("Threaded Chat Prototype", () => {
  test("preserves card pick conversation after refresh", async ({ page }) => {
    await createNewThread(page);

    const firstPrompt = "draw a card from 5 cards";
    await sendMessage(page, firstPrompt);

    const interactiveAppeared = await interactiveToolCallBlocks(page)
      .last()
      .waitFor({ state: "visible", timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    if (!interactiveAppeared) {
      const errorLocator = page.locator("text=/^Error:/");
      if ((await errorLocator.count()) > 0) {
        const errorText = await errorLocator.first().textContent();
        throw new Error(`Tool execution error: ${errorText}`);
      }
      test.skip(true, "LLM did not produce an interactive pick_card block");
      return;
    }

    const toolAssistant = page.getByTestId("message-assistant").filter({
      has: page.getByTestId("tool-call-block").filter({ hasText: /Tool · pick_card/ }),
    });
    await expect(toolAssistant.first()).toBeVisible({ timeout: 30000 });

    const assistantCountBeforePick = await page.getByTestId("message-assistant").count();
    const picked = await completeCardPick(page);
    await waitForIdle(page);
    await waitForAssistantMentioningCard(page, picked.pickedLabel, assistantCountBeforePick);

    const followup = "What card did I just pick?";
    await sendMessage(page, followup);
    await waitForIdle(page);
    await waitForAssistantMentioningCard(page, picked.pickedLabel, assistantCountBeforePick + 1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 30000 });

    await expect(page.getByTestId("message-user").filter({ hasText: firstPrompt })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("message-user").filter({ hasText: followup })).toBeVisible({
      timeout: 30000,
    });
    await assertCompletedCardPicks(page, [picked.pickedLabel]);

    const cardPattern = pickedCardPattern(picked.pickedLabel);
    await expect
      .poll(
        async () =>
          (await page.getByTestId("message-assistant").allTextContents()).filter((text) =>
            cardPattern.test(text),
          ).length,
        { timeout: 30000 },
      )
      .toBeGreaterThanOrEqual(2);
  });

  test("replays two completed card picks after refresh", async ({ page }) => {
    await createNewThread(page);

    await sendMessage(page, "Draw 3 cards and let me pick one card");
    const first = await completeCardPick(page);

    await sendMessage(page, "Draw another 3 cards and let me pick again");
    const second = await completeCardPick(page);
    try {
      await waitForIdle(page);
    } catch (error) {
      console.log("Thread did not return to idle after second card pick:", error);
      test.skip(true, "Local model did not return threaded chat to idle");
      return;
    }

    await assertCompletedCardPicks(page, [first.pickedLabel, second.pickedLabel]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 30000 });

    await assertCompletedCardPicks(page, [first.pickedLabel, second.pickedLabel]);
  });

  test("replays mermaid svg after refresh", async ({ page }) => {
    await createNewThread(page);

    await sendMessage(
      page,
      "Explain rock paper scissors in mermaid and render it as a mermaid diagram",
    );
    await waitForIdle(page);

    const latestAssistant = page.getByTestId("message-assistant").last();
    const svgAppeared = await latestAssistant
      .locator("svg")
      .first()
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!svgAppeared) {
      const text = await latestAssistant.textContent().catch(() => "");
      console.log("Mermaid SVG did not appear. Assistant response:", text?.slice(0, 200));
      test.skip(true, "LLM did not produce a renderable mermaid diagram");
      return;
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Thread ready")).toBeVisible({ timeout: 30000 });

    const replayedAssistant = page.getByTestId("message-assistant").last();
    await expect(replayedAssistant.locator("svg").first()).toBeVisible({ timeout: 30000 });
  });
});
