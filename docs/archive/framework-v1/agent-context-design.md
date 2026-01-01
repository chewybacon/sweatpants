# Agent Context Design

## Overview

The V7 handoff primitive is powerful enough to build "agents" on top of it. The key insight is that **everything can be thought of as a handoff**:

- Browser UI interaction = handoff to user
- Server-side agent = handoff to agent with `ctx.prompt()`
- Nested agents = handoff to sub-agent, use `spawn()` + `all()` for concurrency

The `ctx` object is the **injection point**. What's available depends on the execution environment.

## Core Design Principle

**Same tool definition, different contexts.**

A single tool can work in both browser and agent modes by checking which capabilities are available on `ctx`:

```typescript
*client(handoffData, ctx, _params) {
  const flexCtx = ctx as FlexibleClientContext

  if (flexCtx.prompt) {
    // Agent mode - use LLM for decision
    return yield* flexCtx.prompt({ prompt: '...', schema })
  }

  if (flexCtx.waitFor) {
    // Browser mode - ask user
    return yield* flexCtx.waitFor('pick-choice', { ... })
  }

  // Fallback - deterministic behavior
  return { selected: data.choices[0] }
}
```

## Context Types

### Base Context (`ClientToolContext`)

Always available in any execution environment:

```typescript
interface ClientToolContext {
  callId: string
  signal: AbortSignal
  requestApproval(message: string): Operation<ApprovalResult>
  requestPermission(type: string): Operation<ApprovalResult>
  reportProgress(message: string): Operation<void>
  waitFor?<Req, Res>(type: string, payload: Req): Operation<Res>
}
```

### Browser Context

Extends base with `waitFor` for UI interactions:

```typescript
interface BrowserClientContext extends ClientToolContext {
  waitFor<Req, Res>(type: string, payload: Req): Operation<Res>
}
```

Browser context is created by the chat session when running in a browser environment. The `waitFor` method suspends the tool execution and waits for a React component to respond.

### Agent Context

Extends base with `prompt` for LLM calls:

```typescript
interface AgentContext extends ClientToolContext {
  prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>>
  emit?(event: unknown): Operation<void>
}
```

Agent context is created when running a tool as a server-side agent. The `prompt` method executes a one-shot structured LLM call and returns the parsed result.

### Flexible Context

For tools that want to work in both modes:

```typescript
interface FlexibleClientContext extends ClientToolContext {
  prompt?<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>>
  emit?(event: unknown): Operation<void>
}
```

## Prompt Options

```typescript
interface PromptOptions<T extends z.ZodType> {
  prompt: string        // The prompt text
  schema: T             // Zod schema for structured output
  system?: string       // Optional system prompt
  model?: string        // Optional model override
  temperature?: number  // Optional temperature
}
```

## Execution Patterns

### Pattern 1: Browser-Only Tool

Tool only works in browser, requires user interaction:

```typescript
const userInputTool = defineIsomorphicTool({
  name: 'get_user_input',
  // ...
  *client(data, ctx) {
    // Assumes browser context
    return yield* ctx.waitFor!('input-form', { fields: data.fields })
  }
})
```

### Pattern 2: Agent-Only Tool

Tool only works as an agent, requires LLM:

```typescript
const analysisTool = defineIsomorphicTool({
  name: 'deep_analysis',
  // ...
  *client(data, ctx) {
    const agentCtx = ctx as AgentContext
    if (!agentCtx.prompt) {
      throw new Error('deep_analysis requires agent context')
    }
    
    return yield* agentCtx.prompt({
      prompt: `Analyze: ${data.topic}`,
      schema: z.object({ findings: z.array(z.string()) })
    })
  }
})
```

### Pattern 3: Flexible Tool (Both Modes)

Tool works in both browser and agent modes:

```typescript
const choiceTool = defineIsomorphicTool({
  name: 'make_choice',
  // ...
  *client(data, ctx) {
    const flexCtx = ctx as FlexibleClientContext
    
    if (flexCtx.prompt) {
      // Agent mode
      return yield* flexCtx.prompt({
        prompt: `Choose from: ${data.choices.join(', ')}`,
        schema: z.object({ selected: z.string() })
      })
    }
    
    if (flexCtx.waitFor) {
      // Browser mode
      return yield* flexCtx.waitFor('pick', { choices: data.choices })
    }
    
    // Fallback
    return { selected: data.choices[0] }
  }
})
```

### Pattern 4: Sequential Agent Calls

Agent makes multiple LLM calls in sequence:

```typescript
*client(data, ctx) {
  const agentCtx = ctx as AgentContext
  
  // First call
  const initial = yield* agentCtx.prompt({
    prompt: `Research: ${data.topic}`,
    schema: z.object({ 
      findings: z.array(z.string()),
      needsMore: z.boolean()
    })
  })
  
  if (initial.needsMore) {
    // Second call builds on first
    const deeper = yield* agentCtx.prompt({
      prompt: `Expand on: ${initial.findings.join(', ')}`,
      schema: z.object({ findings: z.array(z.string()) })
    })
    return { findings: [...initial.findings, ...deeper.findings] }
  }
  
  return { findings: initial.findings }
}
```

### Pattern 5: Parallel Agent Calls

Agent makes multiple LLM calls concurrently:

```typescript
import { spawn, all } from 'effection'

*client(data, ctx) {
  const agentCtx = ctx as AgentContext
  
  // Spawn parallel tasks
  const task1 = yield* spawn(function*() {
    return yield* agentCtx.prompt({
      prompt: `Technical analysis of: ${data.topic}`,
      schema: z.object({ analysis: z.string() })
    })
  })
  
  const task2 = yield* spawn(function*() {
    return yield* agentCtx.prompt({
      prompt: `Business analysis of: ${data.topic}`,
      schema: z.object({ analysis: z.string() })
    })
  })
  
  // Wait for all
  const [tech, biz] = yield* all([task1, task2])
  
  return { technical: tech.analysis, business: biz.analysis }
}
```

### Pattern 6: Nested Agents

Outer agent orchestrates inner agents:

```typescript
*client(data, ctx) {
  const agentCtx = ctx as AgentContext
  
  // Execute inner agent's full lifecycle
  function* runInnerAgent(task: string) {
    const phase1 = yield* executeServerPart(innerTool, `inner-${task}`, { task }, agentCtx.signal)
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')
    
    const clientResult = yield* innerTool.client!(
      phase1.serverOutput,
      agentCtx,  // Pass same context to inner agent
      { task }
    )
    
    return yield* executeServerPhase2(
      innerTool, `inner-${task}`, { task },
      clientResult, phase1.serverOutput, agentCtx.signal, true
    )
  }
  
  // Run multiple inner agents in parallel
  const results = yield* all(data.tasks.map(t => runInnerAgent(t)))
  return { results: results.map(r => r.output) }
}
```

### Pattern 7: Streaming Events

Agent emits progress to parent:

```typescript
*client(data, ctx) {
  const agentCtx = ctx as AgentContext
  
  for (let i = 0; i < data.steps; i++) {
    // Emit progress
    if (agentCtx.emit) {
      yield* agentCtx.emit({ type: 'progress', step: i + 1, total: data.steps })
    }
    
    // Do work...
    yield* agentCtx.prompt({ /* ... */ })
  }
  
  return { completed: data.steps }
}
```

## Implementation Plan

### 1. Agent Runtime (`runAsAgent`)

Create a function that executes a tool's `*client()` as an agent:

```typescript
interface RunAsAgentOptions {
  tool: AnyIsomorphicTool
  handoffData: unknown
  params: unknown
  signal: AbortSignal
  
  // LLM client for ctx.prompt()
  llm: {
    prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>>
  }
  
  // Optional event handler for ctx.emit()
  onEmit?: (event: unknown) => Operation<void>
}

function* runAsAgent(options: RunAsAgentOptions): Operation<unknown> {
  const { tool, handoffData, params, signal, llm, onEmit } = options
  
  // Create agent context
  const ctx: AgentContext = {
    callId: `agent-${crypto.randomUUID()}`,
    signal,
    requestApproval: () => function*() { return { approved: true } }(),
    requestPermission: () => function*() { return { approved: true } }(),
    reportProgress: () => function*() {}(),
    prompt: llm.prompt.bind(llm),
    emit: onEmit,
  }
  
  // Execute tool's client
  return yield* tool.client!(handoffData, ctx, params)
}
```

### 2. LLM Client Wrapper

Wrap the AI SDK to provide `prompt()`:

```typescript
import { generateObject } from 'ai'

function createLLMClient(options: { model: LanguageModel }) {
  return {
    *prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>> {
      const { object } = yield* call(generateObject({
        model: opts.model ? getModel(opts.model) : options.model,
        schema: opts.schema,
        prompt: opts.prompt,
        system: opts.system,
        temperature: opts.temperature,
      }))
      return object
    }
  }
}
```

### 3. Integration with Chat Session

When a tool's `*client()` needs to run as an agent instead of in browser:

```typescript
// In session.ts or similar
if (tool.runMode === 'agent') {
  // Don't hand off to browser, run as agent on server
  const result = yield* runAsAgent({
    tool,
    handoffData: phase1.serverOutput,
    params,
    signal,
    llm: createLLMClient({ model: sessionModel }),
    onEmit: (event) => function*() {
      yield* patches.send({ type: 'agent_event', callId, event })
    }()
  })
  
  // Continue to phase 2
  return yield* executeServerPhase2(tool, callId, params, result, phase1.serverOutput, signal, true)
}
```

## Testing Strategy

### Unit Tests (Mock LLM)

Use mock contexts with predetermined responses:

```typescript
const llmResponses = new Map([
  ['analyze', { findings: ['Finding 1', 'Finding 2'] }],
])

const agentCtx = createMockAgentContext('call-1', llmResponses)
const result = yield* tool.client!(handoffData, agentCtx, params)
```

### Integration Tests (Real LLM)

Test with actual LLM calls in CI:

```typescript
describe.skipIf(!process.env.OPENAI_API_KEY)('Agent Integration', () => {
  it('runs tool as agent with real LLM', function*() {
    const llm = createLLMClient({ model: openai('gpt-4o-mini') })
    const result = yield* runAsAgent({ tool, llm, /* ... */ })
    expect(result.findings).toHaveLength(greaterThan(0))
  })
})
```

## File Locations

| File | Purpose |
|------|---------|
| `isomorphic-tools/types.ts` | `AgentContext`, `FlexibleClientContext`, `PromptOptions` |
| `isomorphic-tools/agent-runtime.ts` | `runAsAgent()`, `createLLMClient()` (to be created) |
| `isomorphic-tools/executor.ts` | `executeServerPart()`, `executeServerPhase2()` |
| `isomorphic-tools/__tests__/agent-ctx-exploration.test.ts` | Unit tests with mock LLM |
| `isomorphic-tools/__tests__/agent-integration.test.ts` | Integration tests with real LLM (to be created) |

## Open Questions

1. **Model Selection**: Should `ctx.prompt()` allow model override, or should it always use the session's model?

2. **Cost Tracking**: How do we track token usage across nested agent calls?

3. **Timeout/Cancellation**: How should agent operations respect the parent's abort signal?

4. **Streaming**: Should `ctx.prompt()` support streaming responses, or always wait for complete?

5. **Tool Calling within Agents**: Can an agent's `ctx.prompt()` call other tools? (recursive agents)
