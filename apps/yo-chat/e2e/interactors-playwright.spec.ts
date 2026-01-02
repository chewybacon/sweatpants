/**
 * POC: Interactor-style API with Playwright
 * 
 * This demonstrates using a clean, declarative API similar to Interactors
 * but running on Playwright's real browser infrastructure.
 * 
 * Compare the syntax:
 * 
 * INTERACTORS (vitest/jsdom):
 *   await Button('Submit').click()
 *   await Button('Submit').has({ disabled: true })
 * 
 * THIS BRIDGE (playwright):
 *   await I.Button('Submit').click()
 *   await I.Button('Submit').has({ disabled: true })
 * 
 * NATIVE PLAYWRIGHT:
 *   await page.getByRole('button', { name: 'Submit' }).click()
 *   await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled()
 */

import { test, expect } from '@playwright/test'
import { interactor, including } from './lib/with-playwright'

test.describe('Interactor-style Playwright API', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo/chat/')
    // Wait for page AND pipeline to be ready (required for React state to work)
    const I = interactor(page)
    await I.Heading('Pipeline-Based Chat').exists({ timeout: 10000 })
    await I.HTML('Pipeline ready').exists({ timeout: 10000 })
  })

  test('can find and verify elements', async ({ page }) => {
    const I = interactor(page)
    
    // Clean, declarative syntax
    await I.Heading('Pipeline-Based Chat').exists()
    await I.TextField('Type a message...').exists()
    await I.Button('Send').has({ disabled: true }) // No input yet
  })

  test('can check element absence', async ({ page }) => {
    const I = interactor(page)
    
    // Stop button should not be visible when not streaming
    await I.Button('Stop').absent()
    
    // Send button should exist
    await I.Button('Send').exists()
  })

  test('can find elements by partial text', async ({ page }) => {
    const I = interactor(page)
    
    // Using including() for partial match
    await I.Heading(including('Pipeline')).exists()
    // Note: + is a special regex char, so use plain string here
    await I.HTML('markdown + shiki').exists()
  })

  test('can work with lists using nth()', async ({ page }) => {
    const I = interactor(page)
    
    // Get the first quick action button
    const firstButton = I.Selector('button').first()
    await firstButton.exists()
  })

  test('can interact with form elements', async ({ page }) => {
    const I = interactor(page)
    
    // Verify initial state
    await I.Button('Send').has({ disabled: true })
    
    // Use Playwright's native fill (more reliable for React controlled inputs)
    const input = page.getByPlaceholder('Type a message...')
    await input.click()
    await input.fill('Hello from Playwright!')
    
    // Button should now be enabled (wait for React)
    await I.Button('Send').has({ disabled: false })
    
    // Verify input value using interactor API
    await I.TextField('Type a message...').has({ value: 'Hello from Playwright!' })
  })
})

// Side-by-side comparison
test.describe('Side-by-side comparison', () => {
  test('native Playwright style', async ({ page }) => {
    await page.goto('/demo/chat/')
    await expect(page.getByRole('heading', { name: 'Pipeline-Based Chat' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })
    
    // Native Playwright - more verbose but explicit
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
    
    // Fill and verify
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Hello')
    
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled()
  })

  test('interactor-style API', async ({ page }) => {
    await page.goto('/demo/chat/')
    const I = interactor(page)
    
    // Interactor-style - cleaner, more declarative
    await I.Heading('Pipeline-Based Chat').exists({ timeout: 10000 })
    await I.HTML('Pipeline ready').exists({ timeout: 10000 })
    await I.TextField('Type a message...').exists()
    await I.Button('Send').has({ disabled: true })
    
    // Fill and verify
    const input = page.getByPlaceholder('Type a message...')
    await input.fill('Hello')
    
    // Assertion using Interactor-style API
    await I.Button('Send').has({ disabled: false })
  })
})
