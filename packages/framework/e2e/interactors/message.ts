/**
 * Message Interactor
 *
 * Interactor for individual chat messages in the conversation.
 */
import { createInteractor, including, type Interactor } from '@interactors/html'

/**
 * Message interactor targets individual message elements.
 *
 * Expected DOM structure:
 * ```html
 * <div data-testid="message" data-role="user|assistant" data-message-id="...">
 *   <div data-testid="message-content">
 *     <!-- text or HTML content here -->
 *   </div>
 *   <div data-testid="tool-calls">
 *     <!-- tool call elements here -->
 *   </div>
 * </div>
 * ```
 *
 * @example
 * ```typescript
 * // Check message exists with specific role
 * await Message({ role: 'user' }).exists()
 *
 * // Check message content
 * await Message({ role: 'assistant' }).has({ content: including('Hello') })
 *
 * // Check message has tool calls
 * await Message({ role: 'assistant' }).has({ hasToolCall: true })
 * ```
 */
export const Message = createInteractor<HTMLElement>('Message')
  .selector('[data-testid="message"]')
  .locator((element) => {
    // Locate by content text
    const content = element.querySelector('[data-testid="message-content"]')
    return content?.textContent?.slice(0, 50) ?? ''
  })
  .filters({
    /**
     * The message role (user or assistant).
     */
    role: (element) => element.getAttribute('data-role') as 'user' | 'assistant',

    /**
     * The message ID.
     */
    messageId: (element) => element.getAttribute('data-message-id'),

    /**
     * The text content of the message.
     */
    content: (element) => {
      const content = element.querySelector('[data-testid="message-content"]')
      return content?.textContent ?? ''
    },

    /**
     * The HTML content of the message (for rendered markdown, etc.).
     */
    html: (element) => {
      const content = element.querySelector('[data-testid="message-content"]')
      return content?.innerHTML ?? ''
    },

    /**
     * Whether the message has any tool calls.
     */
    hasToolCall: (element) => {
      const toolCalls = element.querySelector('[data-testid="tool-calls"]')
      return toolCalls !== null && toolCalls.children.length > 0
    },

    /**
     * Number of tool calls in this message.
     */
    toolCallCount: (element) => {
      const toolCalls = element.querySelector('[data-testid="tool-calls"]')
      return toolCalls?.querySelectorAll('[data-testid="tool-call"]').length ?? 0
    },

    /**
     * Whether the message is currently streaming.
     */
    isStreaming: (element) => element.getAttribute('data-streaming') === 'true',

    /**
     * Whether the message has an error.
     */
    hasError: (element) => element.getAttribute('data-error') === 'true',

    /**
     * The error text, if any.
     */
    errorText: (element) => {
      const error = element.querySelector('[data-testid="message-error"]')
      return error?.textContent ?? null
    },

    /**
     * Check if content contains specific text (using including matcher).
     */
    containsText: {
      apply: (element) => {
        const content = element.querySelector('[data-testid="message-content"]')
        return content?.textContent ?? ''
      },
    },
  })
  .actions({
    /**
     * Click the retry button on this message.
     */
    retry: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="retry-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Retry button not found')
        }
        button.click()
      }),

    /**
     * Click the copy button on this message.
     */
    copy: (interactor: Interactor<HTMLElement, any>) =>
      interactor.perform((element) => {
        const button = element.querySelector('[data-testid="copy-button"]') as HTMLButtonElement | null
        if (!button) {
          throw new Error('Copy button not found')
        }
        button.click()
      }),
  })

/**
 * UserMessage - convenience interactor for user messages only.
 */
export const UserMessage = Message.extend<HTMLElement>('UserMessage')
  .selector('[data-testid="message"][data-role="user"]')

/**
 * AssistantMessage - convenience interactor for assistant messages only.
 */
export const AssistantMessage = Message.extend<HTMLElement>('AssistantMessage')
  .selector('[data-testid="message"][data-role="assistant"]')

// Re-export including for use in tests
export { including }
