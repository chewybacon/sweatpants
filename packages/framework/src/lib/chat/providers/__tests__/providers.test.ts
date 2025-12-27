import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { ollamaProvider } from '../ollama'
import { openaiProvider } from '../openai'

describe('Provider Implementations', () => {
  describe('ollamaProvider', () => {
    it('should have correct capabilities', () => {
      expect(ollamaProvider.name).toBe('ollama')
      expect(ollamaProvider.capabilities).toEqual({
        thinking: true,
        toolCalling: true,
      })
    })

    it('should handle basic streaming setup', () => {
      // Test that the function exists and doesn't throw immediately
      const messages = [{ role: 'user', content: 'test' }]
      expect(() => ollamaProvider.stream(messages)).not.toThrow()
    })

    it('should handle messages with tools', () => {
      const messages = [{
        role: 'user',
        content: 'test with tools',
        tool_calls: [{
          id: 'test-call',
          function: {
            name: 'test_function',
            arguments: { param: 'value' }
          }
        }]
      }]

      // Should not throw on valid message format
      expect(() => ollamaProvider.stream(messages)).not.toThrow()
    })


  })

  describe('openaiProvider', () => {
    it('should have correct capabilities', () => {
      expect(openaiProvider.name).toBe('openai')
      expect(openaiProvider.capabilities).toEqual({
        thinking: true,
        toolCalling: true,
      })
    })

    it('should handle basic streaming setup', () => {
      // Test that the function exists and doesn't throw immediately
      const messages = [{ role: 'user', content: 'test' }]
      expect(() => openaiProvider.stream(messages)).not.toThrow()
    })

    it('should handle messages with tools', () => {
      const messages = [{
        role: 'user',
        content: 'test with tools',
        tool_calls: [{
          id: 'test-call',
          function: {
            name: 'test_function',
            arguments: { param: 'value' }
          }
        }]
      }]

      // Should not throw on valid message format
      expect(() => openaiProvider.stream(messages)).not.toThrow()
    })


  })
})