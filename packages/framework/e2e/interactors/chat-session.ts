/**
 * ChatSession Interactor
 *
 * High-level interactor for the chat session container.
 * Provides actions and filters for the overall session state.
 */
import { createInteractor, type Interactor } from '@interactors/html'

/**
 * ChatSession interactor targets the main chat container element.
 *
 * Expected DOM structure:
 * ```html
 * <div data-testid="chat-session" data-streaming="true|false">
 *   <div data-testid="message-list">
 *     <!-- messages here -->
 *   </div>
 *   <form data-testid="chat-input-form">
 *     <input data-testid="chat-input" placeholder="Type a message..." />
 *     <button data-testid="send-button">Send</button>
 *   </form>
 * </div>
 * ```
 *
 * @example
 * ```typescript
 * // Check session is streaming
 * await ChatSession().has({ isStreaming: true })
 *
 * // Check message count
 * await ChatSession().has({ messageCount: 3 })
 *
 * // Send a message
 * await ChatSession().sendMessage('Hello!')
 *
 * // Wait for response
 * await ChatSession().waitForResponse()
 * ```
 */
export const ChatSession = createInteractor<HTMLElement>('ChatSession')
  .selector('[data-testid="chat-session"]')
  .locator((element) => element.getAttribute('data-session-id') ?? 'default')
  .filters({
    /**
     * Whether the session is currently streaming a response.
     */
    isStreaming: (element) => element.getAttribute('data-streaming') === 'true',

    /**
     * Number of messages in the session.
     */
    messageCount: (element) => {
      const list = element.querySelector('[data-testid="message-list"]')
      return list?.querySelectorAll('[data-testid="message"]').length ?? 0
    },

    /**
     * Whether the input is disabled.
     */
    inputDisabled: (element) => {
      const input = element.querySelector('[data-testid="chat-input"]') as HTMLInputElement | null
      return input?.disabled ?? false
    },

    /**
     * Current input value.
     */
    inputValue: (element) => {
      const input = element.querySelector('[data-testid="chat-input"]') as HTMLInputElement | null
      return input?.value ?? ''
    },

    /**
     * Whether there's an error displayed.
     */
    hasError: (element) => {
      const error = element.querySelector('[data-testid="error-message"]')
      return error !== null
    },

    /**
     * The error message text, if any.
     */
    errorText: (element) => {
      const error = element.querySelector('[data-testid="error-message"]')
      return error?.textContent ?? null
    },
  })
  .actions({
    /**
     * Type text into the chat input.
     */
    typeInInput: (interactor: Interactor<HTMLElement, any>, text: string) =>
      interactor.perform((element) => {
        const input = element.querySelector('[data-testid="chat-input"]') as HTMLInputElement | null
        if (!input) {
          throw new Error('Chat input not found')
        }
        // Clear existing value
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))

        // Type new value
        input.value = text
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }),

    /**
     * Click the send button.
     */
    clickSend: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="send-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Send button not found')
        }
        button.click()
      }),

    /**
     * Send a message (type + click send).
     */
    sendMessage: (interactor: Interactor<HTMLElement, any>, text: string) =>
      interactor.perform((element) => {
        // Find and fill the input
        const input = element.querySelector('[data-testid="chat-input"]') as HTMLInputElement | null
        if (!input) {
          throw new Error('Chat input not found')
        }
        input.value = text
        input.dispatchEvent(new Event('input', { bubbles: true }))

        // Find and click the send button
        const button = element.querySelector('[data-testid="send-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Send button not found')
        }
        button.click()
      }),

    /**
     * Submit the form (for enter key behavior).
     */
    submitForm: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const form = element.querySelector('[data-testid="chat-input-form"]') as HTMLFormElement | null
        if (!form) {
          throw new Error('Chat input form not found')
        }
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }),

    /**
     * Click the abort button (if visible).
     */
    abort: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="abort-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Abort button not found')
        }
        button.click()
      }),

    /**
     * Click the reset button.
     */
    reset: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="reset-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Reset button not found')
        }
        button.click()
      }),
  })
