/**
 * Experimental: Interactors bridge for Playwright
 * 
 * This explores running Interactor-style selectors within Playwright's browser context.
 * 
 * KEY INSIGHT: Interactors are designed to run IN the browser (like Cypress).
 * Playwright runs in Node and sends commands TO the browser.
 * 
 * Two possible approaches:
 * 
 * 1. EVALUATE APPROACH: Serialize interactor logic and run it in page.evaluate()
 *    - Pros: True browser execution
 *    - Cons: Complex serialization, loses interactor composability
 * 
 * 2. WRAPPER APPROACH: Create Playwright-native helpers with Interactor-like API
 *    - Pros: Simpler, works with Playwright's async model
 *    - Cons: Not actual Interactors, just similar syntax
 * 
 * This POC explores approach #2 - creating a clean API that feels like Interactors
 * but uses Playwright's Locator API under the hood.
 */

import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Interactor-like wrapper for Playwright
 * Provides a cleaner, more declarative API similar to Interactors
 */
export class PlaywrightInteractor {
  constructor(private page: Page) {}

  /**
   * Button interactor
   * @example
   * await I.Button('Submit').click()
   * await I.Button('Submit').has({ disabled: true })
   */
  Button(nameOrOptions: string | { name?: string; disabled?: boolean }) {
    const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name
    const locator = this.page.getByRole('button', name ? { name } : undefined)
    
    return new InteractorChain(locator, `Button "${name}"`)
  }

  /**
   * TextField interactor (input with placeholder)
   * @example
   * await I.TextField('Enter name...').fillIn('John')
   * await I.TextField('Enter name...').has({ value: 'John' })
   */
  TextField(placeholder: string) {
    const locator = this.page.getByPlaceholder(placeholder)
    return new InteractorChain(locator, `TextField "${placeholder}"`)
  }

  /**
   * Heading interactor
   * @example
   * await I.Heading('Welcome').exists()
   * await I.Heading(including('Welcome')).exists() // partial match
   */
  Heading(text: string | RegExp, options?: { level?: number }) {
    const roleOptions: { name: string | RegExp; level?: number } = { name: text }
    if (options?.level) {
      roleOptions.level = options.level
    }
    const locator = this.page.getByRole('heading', roleOptions)
    return new InteractorChain(locator, `Heading "${text}"`)
  }

  /**
   * Generic HTML element by text
   * @example
   * await I.HTML('Loading...').exists()
   * await I.HTML(including('Loading')).exists() // partial match
   */
  HTML(text: string | RegExp) {
    const locator = this.page.getByText(text)
    return new InteractorChain(locator, `HTML "${text}"`)
  }

  /**
   * Link interactor
   * @example
   * await I.Link('Learn more').click()
   */
  Link(text: string) {
    const locator = this.page.getByRole('link', { name: text })
    return new InteractorChain(locator, `Link "${text}"`)
  }

  /**
   * Custom selector
   * @example
   * await I.Selector('.chat-message').nth(0).has({ text: 'Hello' })
   */
  Selector(selector: string) {
    const locator = this.page.locator(selector)
    return new InteractorChain(locator, `Selector "${selector}"`)
  }
}

/**
 * Chainable interactor operations
 */
class InteractorChain {
  constructor(
    private locator: Locator,
    private description: string
  ) {}

  // ============ ASSERTIONS ============

  /**
   * Assert element exists (visible)
   */
  async exists(options?: { timeout?: number }) {
    await expect(this.locator).toBeVisible(options)
  }

  /**
   * Assert element does not exist (hidden or not in DOM)
   */
  async absent(options?: { timeout?: number }) {
    await expect(this.locator).not.toBeVisible(options)
  }

  /**
   * Assert element has certain properties
   * @example
   * await I.Button('Submit').has({ disabled: true })
   * await I.TextField('Name').has({ value: 'John' })
   */
  async has(filters: {
    disabled?: boolean
    value?: string | RegExp
    text?: string | RegExp
    className?: string | RegExp
    visible?: boolean
    checked?: boolean
    count?: number
  }, options?: { timeout?: number }) {
    if (filters.disabled !== undefined) {
      if (filters.disabled) {
        await expect(this.locator).toBeDisabled(options)
      } else {
        await expect(this.locator).toBeEnabled(options)
      }
    }

    if (filters.value !== undefined) {
      await expect(this.locator).toHaveValue(filters.value, options)
    }

    if (filters.text !== undefined) {
      await expect(this.locator).toHaveText(filters.text, options)
    }

    if (filters.className !== undefined) {
      await expect(this.locator).toHaveClass(filters.className, options)
    }

    if (filters.visible !== undefined) {
      if (filters.visible) {
        await expect(this.locator).toBeVisible(options)
      } else {
        await expect(this.locator).not.toBeVisible(options)
      }
    }

    if (filters.checked !== undefined) {
      if (filters.checked) {
        await expect(this.locator).toBeChecked(options)
      } else {
        await expect(this.locator).not.toBeChecked(options)
      }
    }

    if (filters.count !== undefined) {
      await expect(this.locator).toHaveCount(filters.count, options)
    }
  }

  // ============ ACTIONS ============

  /**
   * Click the element
   */
  async click(options?: { timeout?: number }) {
    await this.locator.click(options)
  }

  /**
   * Fill in a text field (clears existing content)
   */
  async fillIn(text: string, options?: { timeout?: number }) {
    await this.locator.fill(text, options)
  }

  /**
   * Type text (appends to existing content)
   */
  async type(text: string, options?: { timeout?: number; delay?: number }) {
    await this.locator.pressSequentially(text, options)
  }

  /**
   * Clear the input
   */
  async clear() {
    await this.locator.clear()
  }

  /**
   * Focus the element
   */
  async focus() {
    await this.locator.focus()
  }

  /**
   * Blur the element
   */
  async blur() {
    await this.locator.blur()
  }

  /**
   * Press a key
   */
  async press(key: string) {
    await this.locator.press(key)
  }

  // ============ NAVIGATION ============

  /**
   * Get nth element matching this selector
   */
  nth(index: number) {
    return new InteractorChain(this.locator.nth(index), `${this.description}[${index}]`)
  }

  /**
   * Get first element
   */
  first() {
    return new InteractorChain(this.locator.first(), `${this.description}.first()`)
  }

  /**
   * Get last element
   */
  last() {
    return new InteractorChain(this.locator.last(), `${this.description}.last()`)
  }

  /**
   * Filter to elements containing text
   */
  containing(text: string) {
    return new InteractorChain(
      this.locator.filter({ hasText: text }),
      `${this.description} containing "${text}"`
    )
  }

  /**
   * Get underlying Playwright locator (escape hatch)
   */
  get raw() {
    return this.locator
  }
}

/**
 * Create an interactor instance for a page
 * @example
 * const I = interactor(page)
 * await I.Button('Submit').click()
 */
export function interactor(page: Page) {
  return new PlaywrightInteractor(page)
}

/**
 * Helper for partial string matching (similar to Interactors' including())
 */
export function including(substring: string) {
  return new RegExp(substring)
}
