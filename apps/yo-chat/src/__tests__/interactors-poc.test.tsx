/**
 * Proof of Concept: Using Interactors with Vitest for UI testing
 * 
 * Interactors provide a clean, user-centric API for testing UI components:
 * - Button('Send').click()
 * - TextField('Message').fillIn('Hello')
 * - Button('Send').has({ disabled: false })
 * 
 * Key advantage over Playwright: runs in-process with Vitest (fast, no browser needed)
 * Key advantage over Testing Library: cleaner API, better error messages, convergence strategy
 * 
 * NOTE: Components with hooks may fail in monorepo setups due to React duplication.
 * This is a known vitest/monorepo configuration issue, not an Interactors issue.
 * In production, components would be imported from actual source files which resolves correctly.
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { 
  Button, 
  TextField, 
  Heading,
  HTML,
  setDocumentResolver,
  setInteractorTimeout,
  createInteractor,
  including,
} from '@interactors/html'

// Configure interactors for test environment
beforeEach(() => {
  cleanup()
  // Point interactors at the test document (jsdom/happy-dom)
  setDocumentResolver(() => document)
  // Shorter timeout for unit tests
  setInteractorTimeout(3000)
})

// ============================================================================
// BASIC INTERACTOR TESTS
// ============================================================================

describe('Interactors POC - Basic Usage', () => {
  it('can find a button and verify it exists', async () => {
    render(
      <button>
        Submit
      </button>
    )
    
    // Interactor API: find by accessible text
    await Button('Submit').exists()
  })

  it('can check button state with filters', async () => {
    render(
      <div>
        <button disabled>Disabled Button</button>
        <button>Enabled Button</button>
      </div>
    )
    
    // Check disabled state using filter
    await Button('Disabled Button').has({ disabled: true })
    await Button('Enabled Button').has({ disabled: false })
  })

  it('can interact with text fields', async () => {
    const handleChange = vi.fn()
    
    render(
      <input 
        type="text" 
        placeholder="Type here..."
        onChange={(e) => handleChange(e.target.value)}
      />
    )
    
    // TextField interactor can find by placeholder and type
    await TextField('Type here...').fillIn('Hello World')
    
    expect(handleChange).toHaveBeenCalledWith('Hello World')
  })

  it('can find headings', async () => {
    render(
      <div>
        <h1>Main Title</h1>
        <h2>Subtitle</h2>
      </div>
    )
    
    await Heading('Main Title').exists()
    await Heading('Subtitle').exists()
  })
  
  it('can click a button via DOM click', async () => {
    // For click handlers, we can use DOM click directly
    let clicked = false
    
    render(
      <button onClick={() => { clicked = true }}>
        Click Me
      </button>
    )
    
    // Verify button exists
    await Button('Click Me').exists()
    
    // Use DOM click (interactors' click works better in real browsers)
    const button = document.querySelector('button')!
    button.click()
    
    expect(clicked).toBe(true)
  })
})

// ============================================================================
// STATIC COMPONENT TESTS (No hooks - works in all environments)
// ============================================================================

describe('Interactors POC - Static Components', () => {
  it('can verify input states based on props', async () => {
    // Static component without hooks
    function ChatInput({ disabled, placeholder }: { disabled: boolean, placeholder: string }) {
      return (
        <form>
          <input
            type="text"
            placeholder={placeholder}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled}>
            {disabled ? 'Stop' : 'Send'}
          </button>
        </form>
      )
    }
    
    // Test enabled state
    render(<ChatInput disabled={false} placeholder="Type a message..." />)
    
    await TextField('Type a message...').exists()
    await TextField('Type a message...').has({ disabled: false })
    await Button('Send').has({ disabled: false })
    
    cleanup()
    
    // Test disabled state
    render(<ChatInput disabled={true} placeholder="Waiting..." />)
    
    await TextField('Waiting...').has({ disabled: true })
    // Button shows "Stop" text AND is disabled
    await Button('Stop').has({ disabled: true })
  })
  
  it('can test form with controlled input value', async () => {
    // Test with a pre-filled form
    render(
      <form>
        <input
          type="text"
          placeholder="Enter name"
          defaultValue="John Doe"
        />
        <button type="submit">Submit</button>
      </form>
    )
    
    // Check initial value
    await TextField('Enter name').has({ value: 'John Doe' })
    
    // Clear and type new value
    await TextField('Enter name').fillIn('')
    await TextField('Enter name').fillIn('Jane Smith')
    await TextField('Enter name').has({ value: 'Jane Smith' })
  })
})

// ============================================================================
// MESSAGE LIST TESTS (Static - no hooks)
// ============================================================================

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div data-testid="message-list">
      {messages.length === 0 && (
        <p>No messages yet. Start chatting!</p>
      )}
      {messages.map((msg) => (
        <div key={msg.id} data-role={msg.role} className="message">
          <span className="role">{msg.role === 'user' ? 'You' : 'Assistant'}:</span>
          <span className="content">{msg.content}</span>
        </div>
      ))}
    </div>
  )
}

describe('Interactors POC - Message List', () => {
  it('shows empty state when no messages', async () => {
    render(<MessageList messages={[]} />)
    
    // HTML interactor can find any element by text
    await HTML('No messages yet. Start chatting!').exists()
  })

  it('renders messages with correct roles', async () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'Hello there!' },
      { id: '2', role: 'assistant', content: 'Hi! How can I help?' },
    ]
    
    render(<MessageList messages={messages} />)
    
    // Can find text content
    await HTML('Hello there!').exists()
    await HTML('Hi! How can I help?').exists()
    
    // Role labels
    await HTML('You:').exists()
    await HTML('Assistant:').exists()
  })
  
  it('renders multiple assistant messages correctly', async () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'Question 1' },
      { id: '2', role: 'assistant', content: 'Answer 1' },
      { id: '3', role: 'user', content: 'Question 2' },
      { id: '4', role: 'assistant', content: 'Answer 2' },
    ]
    
    render(<MessageList messages={messages} />)
    
    // All messages should exist
    await HTML('Question 1').exists()
    await HTML('Answer 1').exists()
    await HTML('Question 2').exists()
    await HTML('Answer 2').exists()
  })
})

// ============================================================================
// CUSTOM INTERACTORS - Creating domain-specific interactors
// ============================================================================

/**
 * Custom interactor for chat messages
 * This demonstrates how to create domain-specific interactors
 */
const ChatMessage = createInteractor<HTMLDivElement>('ChatMessage')
  .selector('.message')
  .locator((element) => element.querySelector('.content')?.textContent ?? '')
  .filters({
    role: (element) => element.getAttribute('data-role') as 'user' | 'assistant',
    content: (element) => element.querySelector('.content')?.textContent ?? '',
  })
  .actions({
    // Could add actions like 'copy', 'retry', etc.
  })

describe('Interactors POC - Custom Interactors', () => {
  it('can use custom ChatMessage interactor', async () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'What is 2+2?' },
      { id: '2', role: 'assistant', content: 'The answer is 4.' },
    ]
    
    render(<MessageList messages={messages} />)
    
    // Find message by content
    await ChatMessage('What is 2+2?').exists()
    await ChatMessage('The answer is 4.').exists()
    
    // Filter by role
    await ChatMessage('What is 2+2?').has({ role: 'user' })
    await ChatMessage('The answer is 4.').has({ role: 'assistant' })
  })
  
  it('can filter messages by role', async () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'Hello' },
      { id: '2', role: 'assistant', content: 'Hi there!' },
      { id: '3', role: 'user', content: 'How are you?' },
    ]
    
    render(<MessageList messages={messages} />)
    
    // Find specific user message
    await ChatMessage({ role: 'user', content: including('How are') }).exists()
    
    // Find specific assistant message
    await ChatMessage({ role: 'assistant' }).has({ content: 'Hi there!' })
  })
})

// ============================================================================
// ASSERTIONS & MATCHERS
// ============================================================================

describe('Interactors POC - Assertions', () => {
  it('absent() checks element does not exist', async () => {
    render(<div><button>Visible</button></div>)
    
    await Button('Visible').exists()
    await Button('Invisible').absent()
  })

  it('has() with including() matcher for partial matching', async () => {
    render(
      <button className="btn btn-primary large">
        Click Me
      </button>
    )
    
    // Use interactors' including() matcher for partial class matching
    await Button('Click Me').has({ className: including('btn-primary') })
    await Button('Click Me').has({ className: including('large') })
  })
  
  it('can find by partial text with including()', async () => {
    render(
      <div>
        <h1>Welcome to the Chat Application</h1>
      </div>
    )
    
    // including() works for partial text matching too
    await Heading(including('Chat Application')).exists()
  })
  
  it('can check multiple attributes at once', async () => {
    render(
      <button 
        className="btn-primary" 
        disabled 
        title="Submit form"
      >
        Submit
      </button>
    )
    
    // Multiple filter checks in one assertion
    await Button('Submit').has({ 
      disabled: true,
      className: including('primary'),
      title: 'Submit form'
    })
  })
})

// ============================================================================
// COMPARISON: Testing Library vs Interactors
// ============================================================================

describe('Interactors POC - API Comparison', () => {
  it('demonstrates clean Interactor API', async () => {
    render(
      <div>
        <h1>Chat Demo</h1>
        <input type="text" placeholder="Type a message..." />
        <button disabled>Send</button>
        <button>Cancel</button>
      </div>
    )
    
    // Interactors: Clean, chainable, convergent API
    await Heading('Chat Demo').exists()
    await TextField('Type a message...').fillIn('Hello')
    await TextField('Type a message...').has({ value: 'Hello' })
    await Button('Send').has({ disabled: true })
    await Button('Cancel').has({ disabled: false })
    
    // The same with Testing Library would be:
    // const heading = screen.getByRole('heading', { name: 'Chat Demo' })
    // expect(heading).toBeInTheDocument()
    // const input = screen.getByPlaceholderText('Type a message...')
    // await userEvent.type(input, 'Hello')
    // expect(input).toHaveValue('Hello')
    // expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    // expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    
    // Key differences:
    // 1. Interactors are declarative: Button('Send').has({ disabled: true })
    // 2. Built-in convergence: automatically retries until timeout
    // 3. Better error messages with filter mismatches shown clearly
    // 4. Composable: can create custom interactors for domain concepts
  })
})

// ============================================================================
// SUMMARY
// ============================================================================

/**
 * INTERACTORS POC SUMMARY
 * 
 * ✅ WORKS WELL:
 * - Finding elements by text, placeholder, heading level
 * - Checking element states (disabled, value, className)
 * - Partial matching with including()
 * - Custom interactors for domain-specific UI patterns
 * - Clean, declarative API
 * - Built-in convergence (waits for elements automatically)
 * - Excellent error messages showing expected vs received
 * 
 * ⚠️ CONSIDERATIONS:
 * - Click events work better in real browsers than jsdom
 *   (use DOM .click() or testing-library fireEvent as workaround)
 * - Components with hooks need proper React deduplication in monorepos
 *   (this is a vitest/monorepo config issue, not interactors)
 * - Based on Effection for structured concurrency
 * 
 * 📊 COMPARISON TO ALTERNATIVES:
 * - vs Playwright: Interactors run in-process (faster), but less realistic
 * - vs Testing Library: Cleaner API, better errors, but smaller community
 * - vs Cypress: Lighter weight, easier setup, runs in vitest
 * 
 * 🎯 BEST USE CASES:
 * - Component testing in Vitest
 * - Design system testing
 * - Creating reusable page objects
 * - Teams that value clean, declarative test APIs
 */
