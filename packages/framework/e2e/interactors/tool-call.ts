/**
 * ToolCall Interactor
 *
 * Interactor for tool call elements within messages.
 * Handles both server tools and client tools (emissions).
 */
import { createInteractor, type Interactor } from '@interactors/html'

/**
 * Tool call states.
 */
export type ToolCallState = 'pending' | 'running' | 'completed' | 'error' | 'waiting-for-emission'

/**
 * ToolCall interactor targets tool call elements within messages.
 *
 * Expected DOM structure:
 * ```html
 * <div data-testid="tool-call" data-tool-name="..." data-tool-state="pending|running|completed|error|waiting-for-emission">
 *   <div data-testid="tool-name">...</div>
 *   <div data-testid="tool-args">...</div>
 *   <div data-testid="tool-result">...</div>
 *   <div data-testid="tool-emission">
 *     <!-- Client component rendered here -->
 *   </div>
 *   <button data-testid="emission-submit">Submit</button>
 * </div>
 * ```
 *
 * @example
 * ```typescript
 * // Check tool call exists
 * await ToolCall({ toolName: 'get_weather' }).exists()
 *
 * // Check tool state
 * await ToolCall({ toolName: 'get_weather' }).has({ state: 'completed' })
 *
 * // Check tool has emission (client component)
 * await ToolCall({ hasEmission: true }).exists()
 *
 * // Respond to emission
 * await ToolCall({ hasEmission: true }).respond('approved')
 * ```
 */
export const ToolCall = createInteractor<HTMLElement>('ToolCall')
  .selector('[data-testid="tool-call"]')
  .locator((element) => element.getAttribute('data-tool-name') ?? '')
  .filters({
    /**
     * The tool name.
     */
    toolName: (element) => element.getAttribute('data-tool-name'),

    /**
     * The tool call ID.
     */
    toolCallId: (element) => element.getAttribute('data-tool-call-id'),

    /**
     * The tool call state.
     */
    state: (element) => element.getAttribute('data-tool-state') as ToolCallState | null,

    /**
     * Whether the tool call is pending.
     */
    isPending: (element) => element.getAttribute('data-tool-state') === 'pending',

    /**
     * Whether the tool call is running.
     */
    isRunning: (element) => element.getAttribute('data-tool-state') === 'running',

    /**
     * Whether the tool call completed successfully.
     */
    isCompleted: (element) => element.getAttribute('data-tool-state') === 'completed',

    /**
     * Whether the tool call has an error.
     */
    hasError: (element) => element.getAttribute('data-tool-state') === 'error',

    /**
     * Whether the tool call is waiting for an emission response.
     */
    isWaitingForEmission: (element) => element.getAttribute('data-tool-state') === 'waiting-for-emission',

    /**
     * Whether the tool call has an emission (client component).
     */
    hasEmission: (element) => {
      const emission = element.querySelector('[data-testid="tool-emission"]')
      return emission !== null && emission.children.length > 0
    },

    /**
     * The tool arguments as a JSON string.
     */
    argsJson: (element) => {
      const args = element.querySelector('[data-testid="tool-args"]')
      return args?.textContent ?? null
    },

    /**
     * The tool result as text.
     */
    result: (element) => {
      const result = element.querySelector('[data-testid="tool-result"]')
      return result?.textContent ?? null
    },

    /**
     * The error message if the tool failed.
     */
    errorMessage: (element) => {
      const error = element.querySelector('[data-testid="tool-error"]')
      return error?.textContent ?? null
    },
  })
  .actions({
    /**
     * Click the expand/collapse button to show tool details.
     */
    toggleDetails: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="toggle-details-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Toggle details button not found')
        }
        button.click()
      }),

    /**
     * Click a button within the emission component.
     * Used for client tools that render interactive UIs.
     */
    clickEmissionButton: (interactor: Interactor<HTMLElement, any>, buttonText: string) =>
      interactor.perform((element) => {
        const emission = element.querySelector('[data-testid="tool-emission"]')
        if (!emission) {
          throw new Error('Tool emission not found')
        }
        const buttons = emission.querySelectorAll('button')
        const button = Array.from(buttons).find((b) => b.textContent?.includes(buttonText))
        if (!button) {
          throw new Error(`Button with text "${buttonText}" not found in emission`)
        }
        button.click()
      }),

    /**
     * Fill in an input within the emission component.
     */
    fillEmissionInput: (interactor: Interactor<HTMLElement, any>, placeholder: string, value: string) =>
      interactor.perform((element) => {
        const emission = element.querySelector('[data-testid="tool-emission"]')
        if (!emission) {
          throw new Error('Tool emission not found')
        }
        const input = emission.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null
        if (!input) {
          throw new Error(`Input with placeholder "${placeholder}" not found in emission`)
        }
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }),

    /**
     * Submit the emission response.
     * This is typically used after interacting with the emission UI.
     */
    submitEmission: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="emission-submit"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Emission submit button not found')
        }
        button.click()
      }),

    /**
     * Cancel the emission (if supported).
     */
    cancelEmission: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="emission-cancel"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Emission cancel button not found')
        }
        button.click()
      }),

    /**
     * Respond to an emission with a value.
     * This finds and fills the response input, then submits.
     */
    respond: (interactor: Interactor<HTMLElement, any>, value: string) =>
      interactor.perform((element) => {
        const emission = element.querySelector('[data-testid="tool-emission"]')
        if (!emission) {
          throw new Error('Tool emission not found')
        }

        // Find a text input within the emission
        const input = emission.querySelector('input[type="text"], textarea') as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null
        if (input) {
          input.value = value
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }

        // Click submit
        const submitButton = element.querySelector('[data-testid="emission-submit"]') as HTMLButtonElement | null
        if (!submitButton) {
          throw new Error('Emission submit button not found')
        }
        submitButton.click()
      }),
  })

/**
 * PendingToolCall - convenience interactor for pending tool calls.
 */
export const PendingToolCall = ToolCall.extend<HTMLElement>('PendingToolCall')
  .selector('[data-testid="tool-call"][data-tool-state="pending"]')

/**
 * RunningToolCall - convenience interactor for running tool calls.
 */
export const RunningToolCall = ToolCall.extend<HTMLElement>('RunningToolCall')
  .selector('[data-testid="tool-call"][data-tool-state="running"]')

/**
 * CompletedToolCall - convenience interactor for completed tool calls.
 */
export const CompletedToolCall = ToolCall.extend<HTMLElement>('CompletedToolCall')
  .selector('[data-testid="tool-call"][data-tool-state="completed"]')

/**
 * EmissionToolCall - convenience interactor for tool calls waiting for emission.
 */
export const EmissionToolCall = ToolCall.extend<HTMLElement>('EmissionToolCall')
  .selector('[data-testid="tool-call"][data-tool-state="waiting-for-emission"]')
