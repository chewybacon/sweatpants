# Server-Side Pipeline Design

This document explores making the render transform pipeline portable to run server-side with pull-based streaming.

---

## The North Star Demo (Money Shot)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌───────────┐  │
│   │   MacBook   │   │   iPhone    │   │   iPad      │   │  Neovim   │  │
│   │   (React)   │   │   (React)   │   │   (React)   │   │  (Lua)    │  │
│   │             │   │             │   │             │   │           │  │
│   │ > What is   │   │ > What is   │   │ > What is   │   │ > What is │  │
│   │   the...    │   │   the...    │   │   the...    │   │   the...  │  │
│   │             │   │             │   │             │   │           │  │
│   │ The answer  │   │ The answer  │   │ The answer  │   │ The answ  │  │
│   │ is **42**   │   │ is **42**   │   │ is **42**   │   │ is **42** │  │
│   │ because...█ │   │ because...█ │   │ because...█ │   │ because█  │  │
│   │             │   │             │   │             │   │           │  │
│   └─────────────┘   └─────────────┘   └─────────────┘   └───────────┘  │
│                                                                         │
│              ▲              ▲              ▲              ▲             │
│              └──────────────┴──────────────┴──────────────┘             │
│                              │                                          │
│                    Same stream, same frames                             │
│                    Different clients, same cursor                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Demo Script

```
1. Open MacBook browser - start a chat
2. Pull out iPhone - scan QR code - boom, same conversation, streaming
3. Show iPad doing the same
4. Pop open terminal - `nvim +Chat` - same stream, ANSI rendered
5. Keep talking - all 4 devices update in real-time
6. Kill wifi on laptop - conversation continues on other devices
7. Reconnect laptop - catches up instantly from frame N
8. Drop mic
```

### Why This Demo Kills

1. **Immediately understandable** - No explanation needed. People get it in 2 seconds.
2. **Shows the impossible** - "Wait, they're all in sync? Including the terminal?"
3. **Implies everything else** - Multi-device sync ⇒ single-device works ⇒ resume works ⇒ SSR works
4. **Developer catnip** - Every dev has wanted this. Nobody's seen it done well.
5. **B2B story writes itself** - "Support agents switch devices mid-conversation. Customers start on mobile, finish on desktop."

### The One-Liner

> **"Your AI chat, everywhere, in sync, resumable."**

Or more technical:

> **"Frame-indexed streaming. One conversation, every device, never lose a token."**

---

## Why This Matters

Three big wins:

1. **Thin Clients** - Neovim, mobile, constrained devices don't need shiki/mermaid/katex
2. **Durable Streams** - Survive network outages, resume from any point, multi-device
3. **SSR Handoff** - Server renders first frames, client picks up stream seamlessly

## Core Insight

The pipeline is already lazy and pull-based:

```typescript
pipeline.push(token)        // Just buffers (sync, fast)
const frame = yield* pipeline.pull()  // Processes accumulated buffer
```

This maps perfectly to Web Streams API `ReadableStream.pull()`:

```typescript
new ReadableStream({
  async pull(controller) {
    // Called when client is ready for more data
    // We can run pipeline.pull() here!
  }
})
```

## Proof: Pull-Based Backpressure Works

```
[server] pull() called, sending frame 0
[client] received: frame 0
[server] pull() called, sending frame 1      <- Only called after client reads!
[client] render complete, ready for next
[client] received: frame 1
...
```

The ReadableStream `pull()` is demand-driven - it's only called when the consumer is ready. This creates natural backpressure.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Server                                   │
│                                                                  │
│   LLM Stream ──push──→ Token Buffer ──→ Pipeline ──pull──→ Frame │
│   (fast)               (accumulates)    (lazy)            (out)  │
│                                                                  │
│   ReadableStream.pull() calls pipeline.pull()                    │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP Response Stream
                               │ (backpressure via TCP)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Client                                   │
│                                                                  │
│   Stream Reader ──→ Frames ──→ UI                                │
│   (pulls at render pace)                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Sketch

### Server Handler

```typescript
import { run } from 'effection'
import { createPipeline } from '@tanstack/framework/react/chat/pipeline'

// Handler for streaming chat endpoint
export async function handleChatStream(req: Request): Promise<Response> {
  const { messages, processors = 'markdown' } = await req.json()
  
  // Create pipeline with requested processors
  const pipeline = createPipeline({ processors })
  
  // Token buffer - LLM pushes here
  const tokenBuffer: string[] = []
  let streamComplete = false
  let streamError: Error | null = null
  
  // Start LLM stream in background
  const llmPromise = (async () => {
    try {
      for await (const token of streamFromLLM(messages)) {
        tokenBuffer.push(token)
      }
    } catch (e) {
      streamError = e as Error
    } finally {
      streamComplete = true
    }
  })()
  
  // Create pull-based response stream
  const stream = new ReadableStream({
    async pull(controller) {
      // Wait for tokens or completion
      while (tokenBuffer.length === 0 && !streamComplete) {
        await new Promise(r => setTimeout(r, 10))
      }
      
      // Check for errors
      if (streamError) {
        controller.error(streamError)
        return
      }
      
      // Drain tokens into pipeline buffer
      while (tokenBuffer.length > 0) {
        pipeline.push(tokenBuffer.shift()!)
      }
      
      // Pull frame (runs processors on accumulated buffer)
      const frame = await run(function* () {
        if (streamComplete && !pipeline.hasPending) {
          return yield* pipeline.flush()
        }
        return yield* pipeline.pull()
      })
      
      // Send frame to client
      controller.enqueue(JSON.stringify({
        type: 'frame',
        frame,
        done: streamComplete && !pipeline.hasPending,
      }) + '\n')
      
      // Close stream if done
      if (streamComplete && !pipeline.hasPending) {
        controller.close()
      }
    }
  })
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
    }
  })
}
```

### Client Consumer

```typescript
// Client-side hook for pull-based stream
function usePullChat() {
  const [frames, setFrames] = useState<Frame[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  
  const send = async (content: string) => {
    setIsStreaming(true)
    setFrames([])
    
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      body: JSON.stringify({ 
        messages: [{ role: 'user', content }],
        processors: 'full',  // Server runs full pipeline
      }),
    })
    
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    
    while (true) {
      // This read() creates backpressure - server won't send more
      // until we're ready to receive
      const { value, done } = await reader.read()
      if (done) break
      
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!  // Keep incomplete line
      
      for (const line of lines) {
        if (!line) continue
        const { type, frame, done: streamDone } = JSON.parse(line)
        
        if (type === 'frame') {
          // Update UI with pre-rendered frame
          setFrames(prev => [...prev, frame])
          
          // Natural backpressure: we don't read() again until
          // React has rendered this frame
        }
        
        if (streamDone) {
          setIsStreaming(false)
        }
      }
    }
    
    setIsStreaming(false)
  }
  
  return { frames, isStreaming, send }
}
```

## Benefits

1. **Thin Clients**: Neovim/mobile/etc just receive pre-rendered frames
2. **Consistent Rendering**: Everyone gets same shiki/mermaid output
3. **Natural Backpressure**: Client pace controls server processing
4. **Same Pipeline Code**: Identical `createPipeline()` on server and client
5. **Efficient**: Only processes when client is ready (no wasted work)

## Format-Agnostic Frames

For multi-client support, frames could carry multiple formats:

```typescript
interface Block {
  id: string
  type: 'text' | 'code'
  raw: string
  
  // Format-specific renders (computed on server)
  formats: {
    html?: string        // For web
    ansi?: string        // For terminal (Ink)
    nvim?: NvimToken[]   // For Neovim (extmarks)
  }
}

// Client requests specific format
POST /api/chat/stream
{ messages: [...], format: 'ansi' }
```

Or server renders all formats upfront for maximum client flexibility.

## Configuration Options

```typescript
// Hybrid: server does markdown/code, client does mermaid/math
POST /api/chat/stream
{
  messages: [...],
  serverProcessors: ['markdown', 'shiki'],  // Run on server
  clientProcessors: ['mermaid', 'math'],    // Client will run these
}

// Response includes partially-processed frame + hints
{
  type: 'frame',
  frame: { /* with markdown/shiki done */ },
  pendingProcessors: ['mermaid', 'math'],  // Client should run these
}
```

## Questions to Explore

1. **Frame granularity**: How often to emit frames?
   - Every N tokens?
   - Every N milliseconds?
   - On block boundaries (new code block, etc.)?

2. **Processor splitting**: Which run where?
   - Markdown: Fast, run anywhere
   - Shiki: Slow, benefits from server caching
   - Mermaid: Async, needs browser for SVG?
   - Math: Fast, run anywhere

3. **Caching**: Can we cache processor results?
   - Code blocks by content hash?
   - Mermaid diagrams by definition hash?

4. **Multi-format rendering**: Render all formats upfront or on-demand?
   - Upfront: More bandwidth, simpler clients
   - On-demand: Less bandwidth, need format negotiation

## Durable Chat Streams

Because frames are **indexed snapshots**, streams become resumable and auditable.

### Resumable Connections

```typescript
// Client disconnects at frame 47
// ... network outage, tab closed, device switch ...
// Client reconnects (same device or different!)

GET /api/chat/session123/frames?after=47

// Server sends frames 48-current
// No re-streaming from LLM, no lost content
```

### What This Enables

| Feature | Description |
|---------|-------------|
| **Resume** | Reconnect and pick up where you left off |
| **Multi-device** | Start on phone, continue on desktop |
| **Offline-first** | Cache frames locally, sync when online |
| **Replay** | Scrub through conversation like a video |
| **Audit logs** | Every frame is a snapshot, easy to store/debug |

### Frame Index = Log Sequence Number

The frame index acts like a database LSN (Log Sequence Number):

```typescript
interface FrameLog {
  sessionId: string
  frames: Frame[]
  
  // Append-only log operations
  append(frame: Frame): number  // Returns index
  getAfter(index: number): Frame[]
  getRange(start: number, end: number): Frame[]
}
```

This makes the stream:
- **Replayable** from any point
- **Comparable** (client vs server state)
- **Recoverable** (detect gaps, request missing frames)

### Storage Options

```typescript
// In-memory (simple, single server)
const sessions = new Map<string, FrameLog>()

// Redis (distributed, multi-server)
await redis.xadd(`chat:${sessionId}`, '*', 'frame', JSON.stringify(frame))
await redis.xrange(`chat:${sessionId}`, lastId, '+')

// Database (persistent, auditable)
await db.insert(chatFrames).values({ sessionId, index, frame, createdAt })
```

---

## SSR Handoff (The Killer Feature)

Server renders first frames during SSR, client picks up the stream seamlessly.

### The Vision

```
Timeline:
─────────────────────────────────────────────────────────────────→

Server SSR:
  [Request] → [Start LLM] → [Frame 0] → [Frame 1] → [Send HTML]
                                                          │
Client Hydration:                                         │
                                                          ▼
                                            [Receive HTML with Frame 0-1]
                                                          │
                                            [Render initial content]
                                                          │
                                            [Hydrate React]
                                                          │
                                            [Reconnect stream from Frame 2]
                                                          │
                                            [Continue receiving frames...]
```

### Server-Side (During SSR)

```typescript
// In your SSR handler / loader
export async function loader({ request }) {
  const { messages } = await parseRequest(request)
  
  // Start the chat session
  const session = await startChatSession(messages, {
    pipeline: 'full',
    renderOn: 'server',
  })
  
  // Pull first few frames (within SSR budget ~50-100ms)
  const initialFrames = await session.pullFrames({ 
    maxFrames: 3,
    timeoutMs: 80,
  })
  
  return {
    sessionId: session.id,
    initialFrames,
    resumeFrom: initialFrames.length - 1,
  }
}
```

### Component (SSR + Hydration)

```tsx
function ChatPage() {
  const { sessionId, initialFrames, resumeFrom } = useLoaderData()
  
  return (
    <ChatUI 
      sessionId={sessionId}
      initialFrames={initialFrames}
      resumeFrom={resumeFrom}
    />
  )
}

function ChatUI({ sessionId, initialFrames, resumeFrom }) {
  // Start with SSR-rendered frames
  const [frames, setFrames] = useState(initialFrames)
  const [isStreaming, setIsStreaming] = useState(true)
  
  useEffect(() => {
    // After hydration, reconnect to stream
    // This is a fresh connection - simple and robust
    const stream = connectToStream(sessionId, { after: resumeFrom })
    
    stream.onFrame((frame) => {
      setFrames(prev => [...prev, frame])
    })
    
    stream.onComplete(() => {
      setIsStreaming(false)
    })
    
    return () => stream.disconnect()
  }, [sessionId, resumeFrom])
  
  return (
    <div>
      {frames.map(frame => (
        <FrameRenderer key={frame.id} frame={frame} />
      ))}
      {isStreaming && <Spinner />}
    </div>
  )
}
```

### Why "Restart Stream" is the Right Handoff Strategy

Instead of complex hydration matching, we simply:

1. **SSR renders whatever frames are ready** (0, 1, 2, or more)
2. **Client bootstraps with that HTML** (instant content)
3. **Client reconnects to stream fresh** (after=lastFrameIndex)

This avoids:
- Hydration mismatch problems
- Complex state synchronization  
- Race conditions between SSR and client

The reconnection happens **after** React has hydrated the existing DOM. By then:
- User already sees content (great UX)
- React is ready to take over
- Stream continues from known good state

### Timing Budget

```
SSR Budget: ~100ms total

[Parse request]     5ms
[Start LLM]        10ms   (just the request, not waiting for response)
[Wait for frames]  80ms   (pull what we can get)
[Render HTML]       5ms

If LLM is fast (Groq, Claude instant):
  - Might get 2-3 frames with actual content
  
If LLM is slow:
  - Get 0-1 frames (maybe just "Thinking...")
  - Still better than blank loading state!
```

### Graceful Degradation

```typescript
// If SSR times out or fails, just do client-side
const initialFrames = await session.pullFrames({ 
  maxFrames: 3,
  timeoutMs: 80,
}).catch(() => [])  // Empty = client handles everything

// Component handles both cases
function ChatUI({ initialFrames = [] }) {
  // Works whether we got SSR frames or not
}
```

---

## API Design

### Simple API (90% of users)

```typescript
// Just add renderOn: 'server'
const { messages, send } = useChat({
  pipeline: 'full',
  renderOn: 'server',  // That's it!
})
```

### Advanced API (Full control)

```typescript
// Server-side session management
const session = await createServerSession({
  pipeline: { processors: [markdown, shiki] },
  storage: redisStore,  // For distributed systems
  ttl: 3600,  // Session expires after 1 hour
})

// Pull-based streaming with backpressure
const stream = session.createPullStream({
  format: 'html',  // or 'ansi', 'nvim'
  batchSize: 5,    // Frames per pull
})

// Client-side with resume
const { frames, send, resume } = usePullChat({
  sessionId,
  resumeFrom: lastKnownFrame,
  onDisconnect: (lastFrame) => {
    // Save for later resume
    localStorage.set('lastFrame', lastFrame)
  },
})
```

---

## The Core Insight

**Chat streams can be treated like event-sourced logs.**

| Concept | Traditional Streaming | Frame-Indexed Streaming |
|---------|----------------------|------------------------|
| Data model | Token firehose | Indexed frame snapshots |
| Resumability | Start over | Continue from index N |
| Backpressure | None (overwhelm client) | Natural (pull-based) |
| SSR | Not possible | Server renders, client continues |
| Multi-device | Not possible | Resume on any device |
| Debugging | Ephemeral | Replayable, auditable |

The frame index is the key primitive. Once you have indexed snapshots:
- Streams become **resumable** (like database replication)
- Rendering becomes **portable** (server, client, or hybrid)
- SSR becomes **trivial** (just pull N frames, hand off)
- Clients become **thin** (just render pre-processed frames)

---

## Building the North Star Demo

### What We Need

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Server                                      │
│                                                                         │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐    │
│   │  LLM Stream │───→│  Pipeline   │───→│  Frame Store (indexed)  │    │
│   │   (Ollama)  │    │  (server)   │    │  - In-memory for demo   │    │
│   └─────────────┘    └─────────────┘    │  - Redis for prod       │    │
│                                          └───────────┬─────────────┘    │
│                                                      │                  │
│   ┌──────────────────────────────────────────────────┼────────────────┐ │
│   │              Pull Endpoints                      │                │ │
│   │  GET /session/:id/frames?after=N&format=html    ─┤                │ │
│   │  GET /session/:id/frames?after=N&format=ansi    ─┤                │ │
│   │  GET /session/:id/frames?after=N&format=nvim    ─┘                │ │
│   └──────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │  React  │          │  React  │          │ Neovim  │
   │  (web)  │          │ (mobile)│          │  (Lua)  │
   │         │          │         │          │         │
   │ useChat │          │ useChat │          │ bridge  │
   │ format: │          │ format: │          │ format: │
   │  html   │          │  html   │          │  nvim   │
   └─────────┘          └─────────┘          └─────────┘
```

### Implementation Phases

#### Phase 1: Server-Side Frame Store (1-2 days)

```typescript
// Simple in-memory store for demo
interface FrameStore {
  sessions: Map<string, {
    frames: Frame[]
    subscribers: Set<(frame: Frame) => void>
    isComplete: boolean
  }>
  
  createSession(id: string): void
  appendFrame(sessionId: string, frame: Frame): number
  getFramesAfter(sessionId: string, afterIndex: number): Frame[]
  subscribe(sessionId: string, callback: (frame: Frame) => void): () => void
}
```

#### Phase 2: Pull-Based Endpoint (1 day)

```typescript
// Handler
app.get('/api/chat/:sessionId/frames', async (req, res) => {
  const { sessionId } = req.params
  const { after = -1, format = 'html', wait = 'true' } = req.query
  
  const session = frameStore.getSession(sessionId)
  
  // Get any frames already available
  let frames = session.getFramesAfter(parseInt(after))
  
  // If no frames and wait=true, wait for next frame
  if (frames.length === 0 && wait === 'true' && !session.isComplete) {
    frames = [await session.waitForNextFrame()]
  }
  
  // Format frames for client
  const formatted = frames.map(f => formatFrame(f, format))
  
  res.json({
    frames: formatted,
    lastIndex: session.frames.length - 1,
    isComplete: session.isComplete,
  })
})
```

#### Phase 3: Multi-Format Rendering (1-2 days)

```typescript
function formatFrame(frame: Frame, format: 'html' | 'ansi' | 'nvim'): FormattedFrame {
  switch (format) {
    case 'html':
      return {
        ...frame,
        blocks: frame.blocks.map(b => ({
          ...b,
          rendered: b.rendered,  // Already HTML from pipeline
        }))
      }
    
    case 'ansi':
      return {
        ...frame,
        blocks: frame.blocks.map(b => ({
          ...b,
          rendered: htmlToAnsi(b.rendered),  // Convert HTML → ANSI
        }))
      }
    
    case 'nvim':
      return {
        ...frame,
        blocks: frame.blocks.map(b => ({
          ...b,
          rendered: null,
          tokens: htmlToNvimTokens(b.rendered),  // Convert HTML → extmarks
        }))
      }
  }
}
```

#### Phase 4: React Hook for Pull-Based Streaming (1 day)

```typescript
function usePullChat({ sessionId, format = 'html' }) {
  const [frames, setFrames] = useState<Frame[]>([])
  const [isStreaming, setIsStreaming] = useState(true)
  const lastIndex = useRef(-1)
  
  useEffect(() => {
    let cancelled = false
    
    async function poll() {
      while (!cancelled) {
        const res = await fetch(
          `/api/chat/${sessionId}/frames?after=${lastIndex.current}&format=${format}&wait=true`
        )
        const { frames: newFrames, lastIndex: newLastIndex, isComplete } = await res.json()
        
        if (cancelled) break
        
        if (newFrames.length > 0) {
          setFrames(prev => [...prev, ...newFrames])
          lastIndex.current = newLastIndex
        }
        
        if (isComplete) {
          setIsStreaming(false)
          break
        }
      }
    }
    
    poll()
    return () => { cancelled = true }
  }, [sessionId, format])
  
  return { frames, isStreaming }
}
```

#### Phase 5: QR Code Session Sharing (half day)

```typescript
// Generate shareable URL with session ID
function SessionQRCode({ sessionId }) {
  const url = `${window.location.origin}/chat/join/${sessionId}`
  return <QRCode value={url} />
}

// Join endpoint
function JoinPage() {
  const { sessionId } = useParams()
  const { frames, isStreaming } = usePullChat({ sessionId })
  
  // Same UI, different device!
  return <ChatUI frames={frames} isStreaming={isStreaming} />
}
```

#### Phase 6: Neovim Bridge (2-3 days)

```lua
-- Lua side: poll for frames
local function poll_frames(session_id, last_index)
  local url = string.format(
    'http://localhost:8000/api/chat/%s/frames?after=%d&format=nvim&wait=true',
    session_id, last_index
  )
  -- Use curl or plenary.nvim for HTTP
  local response = curl.get(url)
  return vim.json.decode(response.body)
end

-- Render tokens as extmarks
local function render_frame(bufnr, frame)
  for _, block in ipairs(frame.blocks) do
    for _, token in ipairs(block.tokens) do
      vim.api.nvim_buf_set_extmark(bufnr, ns_id, token.line, token.col, {
        end_col = token.end_col,
        hl_group = token.hl_group,
      })
    end
  end
end
```

### Demo Day Checklist

- [ ] Server-side pipeline running
- [ ] Frame store with subscriptions
- [ ] Pull endpoint with format param
- [ ] React web client (MacBook)
- [ ] React mobile client (iPhone/iPad via responsive or PWA)
- [ ] Neovim plugin (basic version)
- [ ] QR code generation for session sharing
- [ ] Network disconnect/reconnect handling
- [ ] Single chat session shared across all clients

### Time Estimate

| Phase | Time |
|-------|------|
| Server-side frame store | 1-2 days |
| Pull-based endpoint | 1 day |
| Multi-format rendering | 1-2 days |
| React pull hook | 1 day |
| QR session sharing | 0.5 day |
| Neovim bridge | 2-3 days |
| Polish & demo prep | 1-2 days |
| **Total** | **~8-12 days** |

---

## Next Steps

1. Create `createPullableStream()` utility for handler
2. Add server-side pipeline support to chat handler
3. Create `usePullChat` hook for clients
4. Add format negotiation (html/ansi/nvim)
5. Implement frame storage abstraction (memory/redis/db)
6. Build SSR integration for TanStack Start
7. Benchmark server vs client pipeline performance

---

## Related Docs

- [Neovim Adapter Design](./neovim-adapter-design.md) - Thin client that benefits from server-side rendering
- [E2E Testing](./e2e-testing.md) - Testing infrastructure for chat UIs
