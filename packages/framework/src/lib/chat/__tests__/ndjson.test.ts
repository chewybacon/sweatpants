/**
 * ndjson.test.ts
 *
 * Tests for the NDJSON stream parser.
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { parseNDJSON } from '../ndjson'

// Helper to create a mock ReadableStream from string chunks
function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
  })
}

// Helper to collect all values from Effection stream
async function collectAll<T>(stream: ReturnType<typeof parseNDJSON<T>>): Promise<T[]> {
  return run(function* () {
    const results: T[] = []
    const subscription = yield* stream
    while (true) {
      const next = yield* subscription.next()
      if (next.done) break
      results.push(next.value)
    }
    return results
  })
}

describe('parseNDJSON', () => {
  describe('basic parsing', () => {
    it('should parse single JSON line', async () => {
      const stream = createMockStream(['{"type":"text","content":"hello"}\n'])
      const results = await collectAll(parseNDJSON<{ type: string; content: string }>(stream))

      expect(results).toEqual([{ type: 'text', content: 'hello' }])
    })

    it('should parse multiple JSON lines', async () => {
      const stream = createMockStream([
        '{"id":1}\n{"id":2}\n{"id":3}\n',
      ])
      const results = await collectAll(parseNDJSON<{ id: number }>(stream))

      expect(results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    })

    it('should handle empty lines between JSON objects', async () => {
      const stream = createMockStream(['{"a":1}\n\n{"b":2}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ a: 1 }, { b: 2 }])
    })

    it('should handle trailing newline', async () => {
      const stream = createMockStream(['{"x":1}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ x: 1 }])
    })

    it('should handle no trailing newline', async () => {
      const stream = createMockStream(['{"x":1}'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ x: 1 }])
    })
  })

  describe('chunk boundary handling', () => {
    it('should handle JSON split across chunks', async () => {
      const stream = createMockStream([
        '{"type":"te',
        'xt","cont',
        'ent":"hello"}\n',
      ])
      const results = await collectAll(parseNDJSON<{ type: string; content: string }>(stream))

      expect(results).toEqual([{ type: 'text', content: 'hello' }])
    })

    it('should handle newline split across chunks', async () => {
      const stream = createMockStream([
        '{"id":1}',
        '\n{"id":2}\n',
      ])
      const results = await collectAll(parseNDJSON<{ id: number }>(stream))

      expect(results).toEqual([{ id: 1 }, { id: 2 }])
    })

    it('should handle multiple objects split unpredictably', async () => {
      // Simulate real network chunking where data arrives in random pieces
      const stream = createMockStream([
        '{"a":1}\n{"b":',
        '2}\n{"c":3}\n{"d":4',
        '}\n',
      ])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }])
    })

    it('should handle single character chunks', async () => {
      const json = '{"x":1}\n'
      const stream = createMockStream(json.split(''))
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ x: 1 }])
    })

    it('should handle chunk ending exactly at newline', async () => {
      const stream = createMockStream([
        '{"id":1}\n',
        '{"id":2}\n',
      ])
      const results = await collectAll(parseNDJSON<{ id: number }>(stream))

      expect(results).toEqual([{ id: 1 }, { id: 2 }])
    })
  })

  describe('whitespace handling', () => {
    it('should handle leading whitespace', async () => {
      const stream = createMockStream(['  {"x":1}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ x: 1 }])
    })

    it('should handle trailing whitespace', async () => {
      const stream = createMockStream(['{"x":1}  \n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ x: 1 }])
    })

    it('should skip whitespace-only lines', async () => {
      const stream = createMockStream(['{"a":1}\n   \n{"b":2}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ a: 1 }, { b: 2 }])
    })
  })

  describe('complex JSON values', () => {
    it('should handle nested objects', async () => {
      const stream = createMockStream(['{"user":{"name":"Alice","age":30}}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ user: { name: 'Alice', age: 30 } }])
    })

    it('should handle arrays', async () => {
      const stream = createMockStream(['{"items":[1,2,3]}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ items: [1, 2, 3] }])
    })

    it('should handle strings with escaped newlines', async () => {
      const stream = createMockStream(['{"text":"line1\\nline2"}\n'])
      const results = await collectAll(parseNDJSON<{ text: string }>(stream))

      expect(results).toEqual([{ text: 'line1\nline2' }])
    })

    it('should handle unicode in strings', async () => {
      const stream = createMockStream(['{"emoji":"👋🌍"}\n'])
      const results = await collectAll(parseNDJSON<{ emoji: string }>(stream))

      expect(results).toEqual([{ emoji: '👋🌍' }])
    })

    it('should handle null and boolean values', async () => {
      const stream = createMockStream(['{"a":null,"b":true,"c":false}\n'])
      const results = await collectAll(parseNDJSON<object>(stream))

      expect(results).toEqual([{ a: null, b: true, c: false }])
    })
  })

  describe('abort signal', () => {
    it('should stop reading when abort signal is triggered before start', async () => {
      const controller = new AbortController()
      controller.abort()

      const stream = createMockStream(['{"a":1}\n{"b":2}\n'])
      const results = await collectAll(parseNDJSON(stream, { signal: controller.signal }))

      expect(results).toEqual([])
    })

    it('should stop reading when abort signal is triggered mid-stream', async () => {
      const controller = new AbortController()

      // Create a stream that will be read partially
      let chunkIndex = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          const chunks = ['{"id":1}\n', '{"id":2}\n', '{"id":3}\n']

          if (chunkIndex < chunks.length) {
            // Abort after first chunk
            if (chunkIndex === 1) {
              controller.abort()
            }
            streamController.enqueue(new TextEncoder().encode(chunks[chunkIndex]))
            chunkIndex++
          } else {
            streamController.close()
          }
        },
      })

      const results = await collectAll(parseNDJSON<{ id: number }>(stream, { signal: controller.signal }))

      // Should have at least the first item, but not all
      expect(results.length).toBeLessThan(3)
    })
  })

  describe('error handling', () => {
    it('should throw on malformed JSON', async () => {
      const stream = createMockStream(['{"invalid json\n'])

      await expect(collectAll(parseNDJSON(stream))).rejects.toThrow()
    })

    it('should throw on truncated JSON', async () => {
      const stream = createMockStream(['{"key":'])

      await expect(collectAll(parseNDJSON(stream))).rejects.toThrow()
    })

    it('should throw on invalid JSON structure', async () => {
      const stream = createMockStream(['not json at all\n'])

      await expect(collectAll(parseNDJSON(stream))).rejects.toThrow()
    })
  })

  describe('empty stream', () => {
    it('should handle empty stream', async () => {
      const stream = createMockStream([])
      const results = await collectAll(parseNDJSON(stream))

      expect(results).toEqual([])
    })

    it('should handle stream with only whitespace', async () => {
      const stream = createMockStream(['   \n\n   '])
      const results = await collectAll(parseNDJSON(stream))

      expect(results).toEqual([])
    })
  })

  describe('stream event types (real-world scenarios)', () => {
    it('should parse typical chat streaming events', async () => {
      const stream = createMockStream([
        '{"type":"session_info","capabilities":{"tools":[]}}\n',
        '{"type":"text","content":"Hello"}\n',
        '{"type":"text","content":" world"}\n',
        '{"type":"complete","text":"Hello world"}\n',
      ])

      const results = await collectAll(parseNDJSON<{ type: string }>(stream))

      expect(results.map(r => r.type)).toEqual([
        'session_info',
        'text',
        'text',
        'complete',
      ])
    })

    it('should handle tool call events', async () => {
      const stream = createMockStream([
        '{"type":"tool_calls","calls":[{"id":"123","name":"search","arguments":{"q":"test"}}]}\n',
        '{"type":"tool_result","id":"123","name":"search","content":"Found 10 results"}\n',
      ])

      interface ToolEvent {
        type: string
        calls?: Array<{ id: string; name: string }>
        id?: string
        content?: string
      }

      const results = await collectAll(parseNDJSON<ToolEvent>(stream))

      expect(results).toHaveLength(2)
      expect(results[0]!.type).toBe('tool_calls')
      expect(results[0]!.calls).toBeDefined()
      expect(results[0]!.calls!.length).toBeGreaterThan(0)
      expect(results[0]!.calls![0]!.name).toBe('search')
      expect(results[1]!.type).toBe('tool_result')
      expect(results[1]!.content).toBe('Found 10 results')
    })
  })
})