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
import { run } from 'effection'
import { runPipeline, createPipeline } from '@tanstack/framework/react/chat/pipeline'

describe('chat streaming', () => {
  it('should stream text and process through pipeline', async () => {
    const frames: any[] = []
    const pipeline = createPipeline({ processors: 'markdown' }, function* (frame) {
      frames.push(frame)
    })

    // Run streaming
    await run(function* () {
      // Stream content
      yield* pipeline.process('First paragraph.\n\n')
      yield* pipeline.process('Second paragraph.')
      yield* pipeline.flush()
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

## Testing the Pipeline System

The modern pipeline system (with markdown, shiki, mermaid, and math processors) replaces the old settler system. For testing pipeline functionality, use the integration tests in `src/react/chat/__tests__/pipeline-preset-validation.test.ts` and `src/react/chat/__tests__/full-pipeline-e2e.test.ts` as examples.

### Example: Testing Pipeline Processing

```typescript
import { run } from 'effection'
import { runPipeline } from '@tanstack/framework/react/chat/pipeline'

describe('pipeline integration', () => {
  it('should process markdown content', async () => {
    const content = '# Title\n\nBody text'
    
    const frame = await run(function* () {
      return yield* runPipeline(content, { processors: 'markdown' })
    })
    
    expect(frame.blocks.length).toBeGreaterThan(0)
    expect(frame.blocks[0].type).toBe('text')
  })

  it('should detect code blocks', async () => {
    const content = '```javascript\nconst x = 1\n```'
    
    const frame = await run(function* () {
      return yield* runPipeline(content, { processors: 'markdown' })
    })
    
    const codeBlock = frame.blocks.find((b) => b.type === 'code')
    expect(codeBlock?.language).toBe('javascript')
  })
})
```

> **Note:** The old settler system is deprecated. See `packages/framework/docs/migration-guide.md` for details on migrating from settlers to the pipeline API.

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

## Testing with the Pipeline Transform

The modern streaming pipeline is tested with the pipeline API. See the integration tests for examples:

- `packages/framework/src/react/chat/__tests__/pipeline-preset-validation.test.ts` - Preset validation
- `packages/framework/src/react/chat/__tests__/full-pipeline-e2e.test.ts` - End-to-end pipeline tests

These tests use `runPipeline()` to process content and emit frames, verifying that processors work correctly with various input types.

> **Legacy Note:** The old `dualBufferTransform` and settler system have been removed. Use the modern pipeline system with `runPipeline()` or `createPipeline()`.

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

## Test File Structure (Current)

The framework includes comprehensive tests for the modern pipeline system:

```
src/react/chat/__tests__/
├── full-pipeline-e2e.test.ts              # Full pipeline e2e tests (16 tests)
├── pipeline-preset-validation.test.ts     # Preset validation (25 tests)
├── mermaid-e2e.test.ts                    # Mermaid processor tests (6 tests)
├── math-processor.test.ts                 # Math processor tests (13 tests)
├── step-lifecycle.test.ts                 # Step state management (4 tests)
└── state.test.ts                          # Session state tests (5 tests)
```

## Best Practices

1. **Use pipeline API** - `runPipeline()` for content processing
2. **Test with presets** - Verify 'markdown', 'shiki', 'mermaid', 'math', 'full'
3. **Stream content** - Use `createPipeline()` to test streaming behavior
4. **Verify block structure** - Check that frames have correct block types
5. **Test integration points** - Ensure processors compose correctly

## Debugging Pipeline Tests

Use the pipeline's frame emissions to debug:

```typescript
const pipeline = createPipeline({ processors: 'full' }, function* (frame) {
  console.log('Frame emitted:', {
    blockCount: frame.blocks.length,
    blockTypes: frame.blocks.map(b => b.type),
    totalContent: frame.blocks.map(b => b.raw).join('').length
  })
})
```

## Related Documentation

- `packages/framework/docs/pipeline-guide.md` - Pipeline system documentation
- `packages/framework/docs/migration-guide.md` - Migrating from settlers to pipeline
- `packages/framework/docs/rendering-engine-design.md` - Architecture details
