/**
 * LLM Integration E2E Tests
 *
 * These tests hit a REAL backend server with a REAL LLM (Ollama).
 * They verify the full chat flow from UI to server to LLM and back.
 *
 * Prerequisites:
 * - Ollama running locally with llama3.1:latest model
 * - OR set E2E_BACKEND_URL to use an existing server
 *
 * Run with:
 *   cd packages/framework/e2e && pnpm exec vitest run llm-integration
 *
 * Debug mode:
 *   E2E_DEBUG=1 pnpm exec vitest run llm-integration
 */
import { render, cleanup } from '@testing-library/react'
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest'
import { startTestServer, stopTestServer, useExistingServer } from '../setup/test-server'
import { e2eConfig } from '../setup/config'

// Interactors
import { ChatSession, Message, setInteractorTimeout } from '../interactors'

// Fixtures
import { ChatDemo } from '../fixtures/ChatDemo'
import { prompts } from '../fixtures/prompts'
import { expectContentToMatch, expected } from '../fixtures/expected'

// Configure longer timeout for interactors since we're hitting real LLM
setInteractorTimeout(e2eConfig.llmResponseTimeout)

describe('LLM Integration', () => {
  // Server URL for chat API
  let apiUrl: string

  // Start server once before all tests
  beforeAll(async () => {
    // Check if we should use an existing server
    if (process.env['E2E_BACKEND_URL']) {
      useExistingServer(process.env['E2E_BACKEND_URL'])
      apiUrl = `${process.env['E2E_BACKEND_URL']}${e2eConfig.chatEndpoint}`
    } else {
      const serverUrl = await startTestServer()
      apiUrl = `${serverUrl}${e2eConfig.chatEndpoint}`
    }
    console.log(`[e2e] Using chat endpoint: ${apiUrl}`)
  }, e2eConfig.serverStartTimeout)

  // Stop server after all tests
  afterAll(async () => {
    // Only stop if we started it
    if (!process.env['E2E_BACKEND_URL']) {
      await stopTestServer()
    }
  })

  // Clean up React renders between tests
  beforeEach(() => {
    cleanup()
  })

  afterEach(() => {
    cleanup()
  })

  // ==========================================================================
  // BASIC CHAT FLOW
  // ==========================================================================

  describe('Basic Chat Flow', () => {
    it(
      'should send a message and receive a response from LLM',
      async () => {
        render(<ChatDemo baseUrl={apiUrl} />)

        // Verify initial state
        await ChatSession().exists()
        await ChatSession().has({ isStreaming: false, messageCount: 0 })

        // Send a simple message
        await ChatSession().sendMessage(prompts.simple.whatIsTwoPlusTwo)

        // Should show streaming state
        await ChatSession().has({ isStreaming: true })

        // Wait for user message to appear
        await Message({ role: 'user' }).exists()

        // Wait for assistant response
        await Message({ role: 'assistant' }).exists()

        // Should have 2 messages now
        await ChatSession().has({ messageCount: 2 })

        // Should stop streaming
        await ChatSession().has({ isStreaming: false })

        // Verify response content contains expected answer
        const assistantEl = document.querySelector('[data-testid="message"][data-role="assistant"]')
        const content = assistantEl?.querySelector('[data-testid="message-content"]')?.textContent ?? ''
        expectContentToMatch(content, expected.simple.whatIsTwoPlusTwo)
      },
      e2eConfig.llmResponseTimeout
    )

    it(
      'should handle a simple echo request',
      async () => {
        render(<ChatDemo baseUrl={apiUrl} />)

        await ChatSession().sendMessage(prompts.simple.echoHello)

        // Wait for response AND streaming to complete
        await Message({ role: 'assistant' }).exists()
        await ChatSession().has({ isStreaming: false })

        // Check response
        const assistantEl = document.querySelector('[data-testid="message"][data-role="assistant"]')
        const content = assistantEl?.querySelector('[data-testid="message-content"]')?.textContent ?? ''
        expectContentToMatch(content, expected.simple.echoHello)
      },
      e2eConfig.llmResponseTimeout
    )
  })

  // ==========================================================================
  // MARKDOWN RENDERING
  // ==========================================================================

  describe('Markdown Rendering', () => {
    it(
      'should render markdown list correctly',
      async () => {
        render(<ChatDemo baseUrl={apiUrl} pipeline="markdown" />)

        await ChatSession().sendMessage(prompts.markdown.simpleList)

        // Wait for response
        await Message({ role: 'assistant' }).exists()
        await ChatSession().has({ isStreaming: false })

        // Check for rendered HTML list
        const assistantEl = document.querySelector('[data-testid="message"][data-role="assistant"]')
        const html = assistantEl?.querySelector('[data-testid="message-content"]')?.innerHTML ?? ''
        expectContentToMatch(html, expected.markdown.simpleList)
      },
      e2eConfig.llmResponseTimeout
    )

    it(
      'should render code blocks',
      async () => {
        render(<ChatDemo baseUrl={apiUrl} pipeline="markdown" />)

        await ChatSession().sendMessage(prompts.markdown.codeBlock)

        // Wait for response
        await Message({ role: 'assistant' }).exists()
        await ChatSession().has({ isStreaming: false })

        // Check for code block
        const assistantEl = document.querySelector('[data-testid="message"][data-role="assistant"]')
        const html = assistantEl?.querySelector('[data-testid="message-content"]')?.innerHTML ?? ''
        expectContentToMatch(html, expected.markdown.codeBlock)
      },
      e2eConfig.llmResponseTimeout
    )
  })

  // ==========================================================================
  // MULTI-TURN CONVERSATION
  // ==========================================================================

  describe('Multi-turn Conversation', () => {
    it(
      'should maintain conversation context across turns',
      async () => {
        render(<ChatDemo baseUrl={apiUrl} />)

        // First turn: set context
        await ChatSession().sendMessage(prompts.multiTurn.setContext)
        await Message({ role: 'assistant' }).exists()
        await ChatSession().has({ isStreaming: false })

        // Second turn: recall context
        await ChatSession().sendMessage(prompts.multiTurn.recallContext)

        // Wait for second response (should be 4 messages: 2 user + 2 assistant)
        // Use a more specific check - wait until we have 4 messages
        await ChatSession().has({ messageCount: 4 })
        await ChatSession().has({ isStreaming: false })

        // The assistant should recall "42"
        const messages = document.querySelectorAll('[data-testid="message"][data-role="assistant"]')
        const lastAssistantContent = messages[messages.length - 1]?.querySelector('[data-testid="message-content"]')?.textContent ?? ''

        expect(lastAssistantContent.toLowerCase()).toContain('42')
      },
      e2eConfig.llmResponseTimeout * 2 // Double timeout for multi-turn
    )
  })

  // ==========================================================================
  // SESSION RESET
  // ==========================================================================

  describe('Session Reset', () => {
    it(
      'should clear conversation and allow fresh start',
      async () => {
        render(<ChatDemo baseUrl={apiUrl} />)

        // Send a message
        await ChatSession().sendMessage(prompts.simple.echoHello)
        await Message({ role: 'assistant' }).exists()
        await ChatSession().has({ isStreaming: false })

        // Reset
        await ChatSession().reset()

        // Should have no messages
        await ChatSession().has({ messageCount: 0 })

        // Send new message
        await ChatSession().sendMessage(prompts.simple.whatIsTwoPlusTwo)
        await Message({ role: 'assistant' }).exists()

        // Should have fresh conversation (2 messages)
        await ChatSession().has({ messageCount: 2 })
      },
      e2eConfig.llmResponseTimeout * 2
    )
  })
})
