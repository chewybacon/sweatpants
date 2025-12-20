# Testing the Chat Streaming System

The chat streaming system includes comprehensive test utilities for end-to-end testing without network dependencies. This guide covers testing strategies, utilities, and patterns.

## Test Utilities

### `createTestStreamer()`

Creates a controllable streamer that lets you step through streaming events in tests.

```typescript
import { createTestStreamer } from './testing'

const { streamer, controls } = createTestStreamer()

// Pass streamer to session options
useChatSession({ streamer, transforms: [...] })

// In your test, control the streaming:
yield* controls.emit({ type: 'text', content: 'Hello ' })
yield* controls.emit({ type: 'text', content: 'world!' })
yield* controls.complete('Hello world!')
```

#### Controls API

| Method | Description |
|--------|-------------|
| `emit(event)` | Emit a stream event (text, thinking, tool_calls, etc.) |
| `complete(text)` | Complete the stream with final text |
| `error(message, recoverable?)` | Emit an error |
| `waitForStart()` | Wait for the streamer to start (Promise) |

#### Stream Events

```typescript
type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; calls: { id: string; name: string; arguments: any }[] }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'tool_error'; id: string; name: string; message: string }
  | { type: 'complete'; text: string; usage?: TokenUsage }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'session_info'; capabilities: Capabilities; persona: string | null }
```

### `createImmediateStreamer()`

For simple tests that don't need step-by-step control:

```typescript
import { createImmediateStreamer } from './testing'

const streamer = createImmediateStreamer(
  [
    { type: 'text', content: 'Hello ' },
    { type: 'text', content: 'world!' },
  ],
  'Hello world!'  // final text
)

// Streamer emits all events immediately when called
```

## Basic Test Pattern

```typescript
import { describe, it, expect } from 'vitest'
import { run, createSignal, createChannel, spawn, each, sleep } from 'effection'
import { runChatSession, createTestStreamer, dualBufferTransform } from './chat'
import type { ChatCommand, ChatPatch } from './types'

describe('chat streaming', () => {
  it('should stream text and emit patches', async () => {
    const result = await run(function* () {
      // Setup
      const { streamer, controls } = createTestStreamer()
      const commands = createSignal<ChatCommand, void>()
      const patches = createChannel<ChatPatch, void>()
      const received: ChatPatch[] = []

      // Collect patches
      yield* spawn(function* () {
        for (const patch of yield* each(patches)) {
          received.push(patch)
          yield* each.next()
        }
      })

      // Run session
      yield* spawn(function* () {
        yield* runChatSession(commands, patches, {
          streamer,
          transforms: [dualBufferTransform()],
        })
      })

      // Send a message
      commands.send({ type: 'send', content: 'Hello' })
      yield* sleep(10)

      // Stream content
      yield* controls.emit({ type: 'text', content: 'First paragraph.\n\n' })
      yield* controls.emit({ type: 'text', content: 'Second paragraph.' })
      yield* controls.complete('First paragraph.\n\nSecond paragraph.')

      yield* sleep(50)
      return received
    })

    // Assertions
    expect(result.some(p => p.type === 'user_message')).toBe(true)
    expect(result.some(p => p.type === 'streaming_start')).toBe(true)
    expect(result.some(p => p.type === 'buffer_settled')).toBe(true)
    expect(result.some(p => p.type === 'assistant_message')).toBe(true)
  })
})
```

## Testing Settlers

Settlers are synchronous and can be tested directly:

```typescript
import { paragraph, timeout, sentence, any, all, codeFence } from './settlers'

describe('paragraph settler', () => {
  const ctx = (pending: string, elapsed = 0) => ({
    pending,
    settled: '',
    elapsed,
    patch: { type: 'streaming_text' as const, content: '' }
  })

  it('should yield on paragraph breaks', () => {
    const settler = paragraph()
    const results = [...settler(ctx('First\n\nSecond\n\nThird'))]
    
    expect(results).toEqual(['First\n\n', 'Second\n\n'])
  })

  it('should yield nothing without breaks', () => {
    const settler = paragraph()
    const results = [...settler(ctx('No breaks here'))]
    
    expect(results).toEqual([])
  })
})

describe('timeout settler', () => {
  it('should yield when elapsed >= timeout', () => {
    const settler = timeout(100)
    
    // Not elapsed enough
    expect([...settler(ctx('pending', 50))]).toEqual([])
    
    // Elapsed enough
    expect([...settler(ctx('pending', 100))]).toEqual(['pending'])
    expect([...settler(ctx('pending', 150))]).toEqual(['pending'])
  })
})

describe('any combinator', () => {
  it('should use first settler that yields', () => {
    const settler = any(paragraph(), timeout(100))
    
    // Paragraph settles first
    expect([...settler(ctx('Hello\n\n', 0))]).toEqual(['Hello\n\n'])
    
    // Timeout settles when no paragraph
    expect([...settler(ctx('Hello', 100))]).toEqual(['Hello'])
  })
})

describe('codeFence settler', () => {
  it('should yield metadata for code fences', () => {
    const settler = codeFence()
    const results = [...settler(ctx('```python\ndef foo():\n```\n'))]
    
    expect(results).toEqual([
      { content: '```python\n', meta: { inCodeFence: true, language: 'python' } },
      { content: 'def foo():\n', meta: { inCodeFence: true, language: 'python' } },
      { content: '```\n', meta: { inCodeFence: false, language: 'python' } },
    ])
  })
})
```

## Testing Processors

Processors are async Operations - use a helper to run them:

```typescript
import { run } from 'effection'
import { markdown, passthrough, syntaxHighlight } from './processors'
import type { ProcessorContext, ProcessedOutput } from './types'

async function runProcessor(
  processor: Processor,
  ctx: ProcessorContext
): Promise<ProcessedOutput[]> {
  return run(function* () {
    const emissions: ProcessedOutput[] = []
    
    function* emit(output: ProcessedOutput) {
      emissions.push(output)
    }
    
    yield* processor(ctx, emit as any)
    return emissions
  })
}

describe('markdown processor', () => {
  it('should parse markdown to HTML', async () => {
    const processor = markdown()
    const results = await runProcessor(processor, {
      chunk: '# Hello\n\nWorld',
      accumulated: '',
      next: '# Hello\n\nWorld'
    })

    expect(results).toHaveLength(1)
    expect(results[0].html).toContain('<h1>')
    expect(results[0].html).toContain('Hello')
  })
})

describe('syntaxHighlight processor', () => {
  it('should emit quick and full passes', async () => {
    const processor = syntaxHighlight()
    const results = await runProcessor(processor, {
      chunk: 'def foo():',
      accumulated: '',
      next: 'def foo():',
      meta: { inCodeFence: true, language: 'python' }
    })

    expect(results).toHaveLength(2)
    expect(results[0].pass).toBe('quick')
    expect(results[1].pass).toBe('full')
    expect(results[0].html).toContain('kw')  // Quick highlight class
  })

  it('should passthrough non-code content', async () => {
    const processor = syntaxHighlight()
    const results = await runProcessor(processor, {
      chunk: 'Regular text',
      accumulated: '',
      next: 'Regular text',
      meta: { inCodeFence: false }
    })

    expect(results).toHaveLength(1)
    expect(results[0].html).toBeUndefined()
  })
})
```

## Testing the Dual Buffer

```typescript
import { dualBufferTransform } from './dualBuffer'
import { paragraph, codeFence } from './settlers'
import { markdown } from './processors'

describe('dualBufferTransform', () => {
  async function runTransform(
    options: DualBufferOptions,
    patches: ChatPatch[]
  ): Promise<ChatPatch[]> {
    return run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()
      const received: ChatPatch[] = []

      // Collect output
      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          received.push(patch)
          yield* each.next()
        }
      })

      // Run transform
      yield* spawn(function* () {
        yield* dualBufferTransform(options)(input, output)
      })

      // Send patches
      for (const patch of patches) {
        yield* input.send(patch)
      }
      yield* input.close()

      yield* sleep(50)
      return received
    })
  }

  it('should settle on paragraph breaks', async () => {
    const result = await runTransform(
      { settler: paragraph() },
      [
        { type: 'streaming_start' },
        { type: 'streaming_text', content: 'First\n\n' },
        { type: 'streaming_text', content: 'Second' },
        { type: 'streaming_end' },
      ]
    )

    const settled = result.filter(p => p.type === 'buffer_settled')
    expect(settled).toHaveLength(2)
    expect(settled[0].content).toBe('First\n\n')
    expect(settled[1].content).toBe('Second')
  })

  it('should include HTML when using markdown processor', async () => {
    const result = await runTransform(
      { settler: paragraph(), processor: markdown() },
      [
        { type: 'streaming_start' },
        { type: 'streaming_text', content: '# Hello\n\n' },
        { type: 'streaming_end' },
      ]
    )

    const settled = result.find(p => p.type === 'buffer_settled')
    expect(settled?.html).toContain('<h1>')
  })
})
```

## Testing Tool Calls

```typescript
it('should handle tool call flow', async () => {
  const result = await run(function* () {
    const { streamer, controls } = createTestStreamer()
    const commands = createSignal<ChatCommand, void>()
    const patches = createChannel<ChatPatch, void>()
    const received: ChatPatch[] = []

    yield* spawn(function* () {
      for (const patch of yield* each(patches)) {
        received.push(patch)
        yield* each.next()
      }
    })

    yield* spawn(function* () {
      yield* runChatSession(commands, patches, { streamer })
    })

    commands.send({ type: 'send', content: 'Search for X' })
    yield* sleep(10)

    // Emit tool call
    yield* controls.emit({
      type: 'tool_calls',
      calls: [{ id: 'call_1', name: 'search', arguments: { query: 'X' } }]
    })

    // Emit result
    yield* controls.emit({
      type: 'tool_result',
      id: 'call_1',
      name: 'search',
      content: 'Found: X is...'
    })

    // Continue with text
    yield* controls.emit({ type: 'text', content: 'Based on my search...' })
    yield* controls.complete('Based on my search...')

    yield* sleep(50)
    return received
  })

  expect(result.some(p => p.type === 'tool_call_start')).toBe(true)
  expect(result.some(p => p.type === 'tool_call_result')).toBe(true)
})
```

## Testing Error Handling

```typescript
it('should handle recoverable errors', async () => {
  const result = await run(function* () {
    const { streamer, controls } = createTestStreamer()
    const commands = createSignal<ChatCommand, void>()
    const patches = createChannel<ChatPatch, void>()
    const received: ChatPatch[] = []

    yield* spawn(function* () {
      for (const patch of yield* each(patches)) {
        received.push(patch)
        yield* each.next()
      }
    })

    yield* spawn(function* () {
      yield* runChatSession(commands, patches, { streamer })
    })

    commands.send({ type: 'send', content: 'Hello' })
    yield* sleep(10)

    // Emit recoverable error
    yield* controls.emit({
      type: 'error',
      message: 'Rate limited, retrying...',
      recoverable: true
    })

    // Continue after error
    yield* controls.emit({ type: 'text', content: 'Success!' })
    yield* controls.complete('Success!')

    yield* sleep(50)
    return received
  })

  expect(result.some(p => p.type === 'error')).toBe(true)
  expect(result.some(p => p.type === 'assistant_message')).toBe(true)
})
```

## Edge Case Tests

The test suite includes comprehensive edge case coverage:

```typescript
describe('edge cases', () => {
  it('should handle empty content', async () => { ... })
  it('should handle very long content', async () => { ... })
  it('should handle unicode and emoji', async () => { ... })
  it('should handle unclosed code fences', async () => { ... })
  it('should handle Windows line endings', async () => { ... })
  it('should handle rapid chunk emissions', async () => { ... })
})
```

## Running Tests

```bash
# Run all chat tests
cd apps/dynobase
npx vitest run src/demo/effection/chat/__tests__/

# Run specific test file
npx vitest run src/demo/effection/chat/__tests__/settlers.test.ts

# Watch mode
npx vitest src/demo/effection/chat/__tests__/

# With coverage
npx vitest run --coverage src/demo/effection/chat/__tests__/
```

## Test File Structure

```
__tests__/
├── settlers.test.ts           # Settler unit tests (46 tests)
├── processors.test.ts         # Processor unit tests (34 tests)
├── session-e2e.test.ts        # Full session e2e tests (15 tests)
├── edge-cases.test.ts         # Edge case coverage (16 tests)
├── readNdjson.test.ts         # NDJSON parser tests (27 tests)
├── streaming-end-flush.test.ts # Buffer flush tests (19 tests)
├── quick-highlight.test.ts    # Syntax highlight tests (8 tests)
└── code-fence-streaming.test.ts # Code fence behavior tests
```

## Best Practices

1. **Use `yield* sleep()`** - Allow time for async operations to complete
2. **Collect all patches** - Spawn a collector before running the session
3. **Test the output, not internals** - Focus on emitted patches
4. **Use `createImmediateStreamer`** for simple cases - Faster, less setup
5. **Test settlers directly** - They're sync, no Effection needed
6. **Use the helper for processors** - `runProcessor()` simplifies async testing

## Debugging Tests

Enable debug logging in transforms:

```typescript
dualBufferTransform({ 
  settler: paragraph(),
  debug: true  // Logs settle events
})
```

Or use the logging transform:

```typescript
import { loggingTransform } from './transforms'

useChatSession({
  transforms: [
    loggingTransform('before'),
    dualBufferTransform(),
    loggingTransform('after'),
  ]
})
```

## Related

- [chat-streaming.md](./chat-streaming.md) - Main system documentation
- [settlers.md](./settlers.md) - Settler documentation
- [processors.md](./processors.md) - Processor documentation
