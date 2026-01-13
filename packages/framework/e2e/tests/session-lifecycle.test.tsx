/**
 * Session Lifecycle E2E Tests
 *
 * Tests the basic lifecycle of a chat session:
 * - Initial state (empty, not streaming)
 * - Sending a message
 * - Receiving a response
 * - Resetting the session
 *
 * NOTE: These tests use the real backend but we start with component-only tests
 * to verify the interactors work before adding server integration.
 */
import { render, cleanup } from '@testing-library/react'
import { describe, it, beforeEach, afterEach } from '../setup/vitest-effection.ts'
import { call } from 'effection'

// Interactors
import { ChatSession, Message, including } from '../interactors/index.ts'

// Fixtures
import { ChatDemo } from '../fixtures/ChatDemo.tsx'

describe('Session Lifecycle - Component Only', () => {
  // Clean up React renders between tests
  beforeEach(function* () {
    cleanup()
  })

  afterEach(() => {
    cleanup()
  })

  // ==========================================================================
  // INITIAL STATE TESTS
  // ==========================================================================

  it('should render chat session with empty message list', function* () {
    render(<ChatDemo />)

    // Session should exist and not be streaming
    yield* call(() => ChatSession().exists())
    yield* call(() => ChatSession().has({ isStreaming: false }))

    // No messages initially
    yield* call(() => ChatSession().has({ messageCount: 0 }))

    // Input should be enabled
    yield* call(() => ChatSession().has({ inputDisabled: false }))

    // No error
    yield* call(() => ChatSession().has({ hasError: false }))
  })

  it('should have empty input field', function* () {
    render(<ChatDemo />)

    yield* call(() => ChatSession().has({ inputValue: '' }))
  })

  // ==========================================================================
  // INPUT INTERACTION TESTS
  // ==========================================================================

  it('should allow typing in input field', function* () {
    render(<ChatDemo />)

    // Type in the input
    yield* call(() => ChatSession().typeInInput('Hello world'))

    // Input should have the value
    yield* call(() => ChatSession().has({ inputValue: 'Hello world' }))
  })

  // Skip this test - requires server connection to add user messages
  // The useChat hook sends to the server before adding user message
  it.skip('should add user message when sending', function* () {
    render(<ChatDemo />)

    // Send a message (note: without server, this won't stream but should add user message)
    yield* call(() => ChatSession().sendMessage('Hello'))

    // User message should appear (the hook adds user message immediately)
    yield* call(() => Message({ role: 'user' }).exists())
    yield* call(() => Message({ role: 'user' }).has({ content: including('Hello') }))

    // Message count should be at least 1
    yield* call(() => ChatSession().has({ messageCount: 1 }))
  })
})
