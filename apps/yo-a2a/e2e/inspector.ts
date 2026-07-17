import { expect, type Locator, type Page } from "@playwright/test";

export class A2AInspector {
  readonly cardUrl: Locator;
  readonly connectButton: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly messages: Locator;
  readonly validation: Locator;
  readonly contextId: Locator;
  readonly debug: Locator;

  constructor(readonly page: Page) {
    this.cardUrl = page.locator("#agent-card-url");
    this.connectButton = page.locator("#connect-btn");
    this.chatInput = page.locator("#chat-input");
    this.sendButton = page.locator("#send-btn");
    this.messages = page.locator("#chat-messages");
    this.validation = page.locator("#validation-errors");
    this.contextId = page.locator("#session-details");
    this.debug = page.locator("#debug-content");
  }

  async goto(): Promise<void> {
    await this.page.goto("/");
    await expect(this.cardUrl).toBeVisible({ timeout: 15_000 });
  }

  async setBearer(token: string): Promise<void> {
    await this.page.locator("#http-headers-toggle").click();
    await this.page.locator("#auth-type").selectOption("bearer");
    await this.page.locator("#bearer-token").fill(token);
  }

  async connect(cardUrl: string): Promise<void> {
    await this.cardUrl.fill(cardUrl);
    await this.connectButton.click();
  }

  async expectConnectionFailure(): Promise<void> {
    await expect(this.validation).toContainText(/error|failed/i, { timeout: 20_000 });
    await expect(this.chatInput).toBeDisabled();
  }

  async expectConnected(): Promise<void> {
    await expect(this.page.locator("#agent-card-content")).toContainText("yo-a2a-cards", {
      timeout: 30_000,
    });
    await expect(this.chatInput).toBeEnabled({ timeout: 30_000 });
    await expect(this.page.locator("#session-transport")).toContainText("HTTP+JSON");
  }

  async send(text: string): Promise<void> {
    await this.chatInput.fill(text);
    await this.sendButton.click();
  }

  async expectAnswer(text: string): Promise<void> {
    await expect(this.messages).toContainText(text, { timeout: 30_000 });
  }

  async currentContext(): Promise<string> {
    await expect(this.contextId).not.toHaveText("No active session", { timeout: 30_000 });
    return (await this.contextId.textContent())!.trim();
  }

  async showDebug(): Promise<void> {
    const button = this.page.locator("#toggle-console-btn");
    if ((await button.textContent())?.trim() === "Show") {await button.click();}
    await expect(this.debug).toBeVisible();
  }
}
