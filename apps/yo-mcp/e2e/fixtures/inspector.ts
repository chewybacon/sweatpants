import { type Page, type Locator, expect } from '@playwright/test'

/**
 * Page object for interacting with the MCP Inspector UI.
 * 
 * The Inspector has several key areas:
 * - Connection panel: Shows server connection status
 * - Tools tab: Lists available tools with run buttons
 * - Resources tab: Lists resources (not used in yo-mcp)
 * - Prompts tab: Lists prompts (not used in yo-mcp)
 * - Notifications pane: Shows logs and server messages
 */
export class McpInspector {
  readonly page: Page

  // Connection UI
  readonly connectButton: Locator
  readonly connectionStatus: Locator

  // Navigation tabs
  readonly toolsTab: Locator
  readonly resourcesTab: Locator
  readonly promptsTab: Locator

  // Tools panel
  readonly toolsList: Locator

  // Result/output area
  readonly resultPanel: Locator

  // Notifications/logs
  readonly notificationsPane: Locator

  constructor(page: Page) {
    this.page = page

    // Connection UI - these selectors may need adjustment based on actual Inspector UI
    this.connectButton = page.getByRole('button', { name: /connect/i })
    this.connectionStatus = page.locator('[data-testid="connection-status"]')

    // Navigation tabs
    this.toolsTab = page.getByRole('tab', { name: /tools/i })
    this.resourcesTab = page.getByRole('tab', { name: /resources/i })
    this.promptsTab = page.getByRole('tab', { name: /prompts/i })

    // Tools panel
    this.toolsList = page.locator('[data-testid="tools-list"]')

    // Result panel
    this.resultPanel = page.locator('[data-testid="result-panel"]')

    // Notifications
    this.notificationsPane = page.locator('[data-testid="notifications"]')
  }

  /**
   * Navigate to the Inspector and wait for it to load.
   */
  async goto(authToken?: string) {
    const url = authToken 
      ? `/?MCP_PROXY_AUTH_TOKEN=${authToken}`
      : '/'
    await this.page.goto(url)
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Wait for the server to connect.
   */
  async waitForConnection(timeout = 10000) {
    // Look for indicators that we're connected
    // This might be a status badge, the tools list populating, etc.
    await expect(this.page.getByText(/connected/i)).toBeVisible({ timeout })
  }

  /**
   * Click the Tools tab to show the tools list.
   */
  async showToolsTab() {
    await this.toolsTab.click()
    await expect(this.toolsList).toBeVisible()
  }

  /**
   * Get a locator for a specific tool by name.
   */
  getToolByName(name: string): Locator {
    // Tools are typically listed with their name visible
    return this.page.locator(`[data-tool-name="${name}"]`).or(
      this.page.getByText(name, { exact: true }).locator('..')
    )
  }

  /**
   * Click the "Run" button for a specific tool.
   */
  async runTool(name: string) {
    const toolRow = this.getToolByName(name)
    await toolRow.getByRole('button', { name: /run/i }).click()
  }

  /**
   * Fill in tool arguments in the tool's input form.
   */
  async fillToolArguments(args: Record<string, string | number | boolean>) {
    for (const [key, value] of Object.entries(args)) {
      const input = this.page.locator(`[name="${key}"]`).or(
        this.page.getByLabel(key)
      )
      
      if (typeof value === 'boolean') {
        if (value) {
          await input.check()
        } else {
          await input.uncheck()
        }
      } else {
        await input.fill(String(value))
      }
    }
  }

  /**
   * Submit the tool arguments form.
   */
  async submitToolArguments() {
    await this.page.getByRole('button', { name: /run|execute|submit/i }).click()
  }

  /**
   * Wait for a sampling request to appear.
   * Returns a locator for the sampling request UI.
   */
  async waitForSamplingRequest(timeout = 30000): Promise<Locator> {
    const samplingUI = this.page.locator('[data-testid="sampling-request"]').or(
      this.page.getByText(/sampling request/i)
    )
    await expect(samplingUI).toBeVisible({ timeout })
    return samplingUI
  }

  /**
   * Fill in a sampling response.
   */
  async fillSamplingResponse(response: {
    text: string
    model?: string
  }) {
    // Find the sampling response form
    const responseInput = this.page.locator('[data-testid="sampling-response-text"]').or(
      this.page.getByLabel(/response|message|content/i)
    )
    await responseInput.fill(response.text)

    if (response.model) {
      const modelInput = this.page.locator('[data-testid="sampling-response-model"]').or(
        this.page.getByLabel(/model/i)
      )
      await modelInput.fill(response.model)
    }
  }

  /**
   * Submit the sampling response.
   */
  async submitSamplingResponse() {
    await this.page.getByRole('button', { name: /send|submit|respond/i }).click()
  }

  /**
   * Wait for an elicitation request to appear.
   * Returns a locator for the elicitation UI.
   */
  async waitForElicitationRequest(timeout = 30000): Promise<Locator> {
    const elicitUI = this.page.locator('[data-testid="elicitation-request"]').or(
      this.page.getByText(/elicitation|user input/i)
    )
    await expect(elicitUI).toBeVisible({ timeout })
    return elicitUI
  }

  /**
   * Fill in an elicitation response form.
   */
  async fillElicitationResponse(fields: Record<string, string | number | boolean>) {
    for (const [key, value] of Object.entries(fields)) {
      const input = this.page.locator(`[name="${key}"]`).or(
        this.page.getByLabel(key)
      )
      
      if (typeof value === 'boolean') {
        if (value) {
          await input.check()
        } else {
          await input.uncheck()
        }
      } else {
        await input.fill(String(value))
      }
    }
  }

  /**
   * Accept the elicitation (submit with "accept" action).
   */
  async acceptElicitation() {
    await this.page.getByRole('button', { name: /accept|submit|confirm/i }).click()
  }

  /**
   * Decline the elicitation.
   */
  async declineElicitation() {
    await this.page.getByRole('button', { name: /decline|reject/i }).click()
  }

  /**
   * Cancel the elicitation.
   */
  async cancelElicitation() {
    await this.page.getByRole('button', { name: /cancel/i }).click()
  }

  /**
   * Wait for a tool result to appear.
   */
  async waitForToolResult(timeout = 30000): Promise<Locator> {
    const resultUI = this.page.locator('[data-testid="tool-result"]').or(
      this.page.getByText(/result|output/i).locator('..')
    )
    await expect(resultUI).toBeVisible({ timeout })
    return resultUI
  }

  /**
   * Get the tool result as text.
   */
  async getToolResultText(): Promise<string> {
    const result = await this.waitForToolResult()
    return result.textContent() ?? ''
  }

  /**
   * Get the tool result as parsed JSON.
   */
  async getToolResultJson<T = unknown>(): Promise<T> {
    const text = await this.getToolResultText()
    // Extract JSON from the result text (might be wrapped in UI elements)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error(`Could not extract JSON from result: ${text}`)
    }
    return JSON.parse(jsonMatch[0])
  }

  /**
   * Check if there's an error displayed.
   */
  async hasError(): Promise<boolean> {
    const errorUI = this.page.locator('[data-testid="error"]').or(
      this.page.getByText(/error/i)
    )
    return errorUI.isVisible()
  }

  /**
   * Get error message if present.
   */
  async getErrorMessage(): Promise<string | null> {
    const errorUI = this.page.locator('[data-testid="error"]').or(
      this.page.getByText(/error/i).locator('..')
    )
    if (await errorUI.isVisible()) {
      return errorUI.textContent()
    }
    return null
  }

  /**
   * Take a screenshot for debugging.
   */
  async screenshot(name: string) {
    await this.page.screenshot({ path: `test-results/${name}.png`, fullPage: true })
  }
}
