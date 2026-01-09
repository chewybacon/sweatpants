Now I have a clear picture. Let me formulate the detailed phased plan:

---
Detailed Implementation Plan: Server-Side Pipeline with Multi-Device Streaming
Overview
Goal: Build the "money shot" demo - same AI chat streaming to multiple devices (web, mobile, Neovim) in real-time, with resumable connections.
Core Insight: Frame-indexed, pull-based streaming turns chat into event-sourced logs.
---

Phase 0: Foundation Verification (Pre-flight)
Time: 0.5 days
Objective
Verify existing infrastructure works and establish baseline tests.
Tasks
- [ ] Run existing E2E tests to ensure baseline works
- [ ] Verify pipeline push/pull works in isolation (unit test)
- [ ] Verify handler streaming works (existing tests)
Verification
# All tests pass
cd packages/framework && pnpm test
cd packages/framework/e2e && pnpm exec vitest run
---

Phase 1: Frame Store Abstraction
Time: 1-2 days
Objective
Create an indexed frame store that supports append-only semantics and subscriptions.
New Files
packages/framework/src/lib/chat/frame-store/
├── types.ts           # FrameStore interface
├── memory-store.ts    # In-memory implementation
├── index.ts           # Exports
Interface Design
interface FrameStore {
  // Lifecycle
  createSession(sessionId: string): void
  deleteSession(sessionId: string): void

  // Append-only log
  append(sessionId: string, frame: Frame): number  // Returns index
  getFramesAfter(sessionId: string, afterIndex: number): Frame[]
  getFrame(sessionId: string, index: number): Frame | null

  // Subscriptions (for real-time push to connected clients)
  subscribe(sessionId: string, callback: (frame: Frame, index: number) => void): () => void

  // Status
  getSessionInfo(sessionId: string): { frameCount: number, isComplete: boolean } | null
  markComplete(sessionId: string): void
}
Verification
// Unit tests
describe('MemoryFrameStore', () => {
  it('appends frames and returns incrementing indices')
  it('getFramesAfter returns only frames after given index')
  it('subscribe receives new frames in real-time')
  it('subscribe callback not called for frames before subscription')
  it('markComplete prevents further appends')
})
---
Phase 2: Server-Side Pipeline Integration
Time: 1-2 days
Objective
Run the pipeline on the server and emit indexed frames instead of raw text.
Changes to Handler
Option: Add pipeline config to handler and new frame event type.
// New event type in handler/types.ts
type StreamEvent =
  | { type: 'frame'; frame: Frame; index: number }
  | { type: 'text'; text: string }  // Keep for backwards compat
  | ... existing events
// New config option
interface ChatHandlerConfig {
  pipeline?: {
    processors: Processor[]
    format?: 'html' | 'ansi' | 'nvim'
  }
}
Integration Point: Modify the text event handling in create-handler.ts:
// When pipeline enabled, accumulate text and emit frames
if (config.pipeline) {
  pipeline.push(event.text)
  const frame = yield* pipeline.pull()
  const index = frameStore.append(sessionId, frame)
  emit({ type: 'frame', frame, index })
} else {
  // Legacy: emit raw text
  emit({ type: 'text', text: event.text })
}
Verification
describe('Server-side pipeline', () => {
  it('emits frame events instead of text when pipeline configured')
  it('frames include incrementing indices')
  it('markdown/code highlighting applied server-side')
  it('backwards compatible: no pipeline = text events')
})
---
Phase 3: Pull-Based Endpoint
Time: 1 day
Objective
Add a pull-based endpoint that clients can use to fetch frames on-demand.
New Endpoint
GET /api/chat/:sessionId/frames?after=N&format=html&wait=true
Response Format
interface PullResponse {
  frames: Array<{ index: number; frame: Frame }>
  lastIndex: number
  isComplete: boolean
}
Implementation
// New route handler
async function handleFramesPull(req: Request): Promise<Response> {
  const { sessionId, after, format, wait } = parseParams(req)

  let frames = frameStore.getFramesAfter(sessionId, after)

  // Long-poll if no frames and wait=true
  if (frames.length === 0 && wait && !frameStore.isComplete(sessionId)) {
    frames = await waitForNextFrame(sessionId, timeout)
  }

  // Format frames for requested output
  const formatted = frames.map(f => formatFrame(f, format))

  return Response.json({
    frames: formatted,
    lastIndex: frameStore.getSessionInfo(sessionId).frameCount - 1,
    isComplete: frameStore.isComplete(sessionId),
  })
}
Verification
describe('Pull endpoint', () => {
  it('returns frames after given index')
  it('long-polls when wait=true and no new frames')
  it('returns immediately when wait=false')
  it('respects format parameter (html/ansi)')
  it('returns isComplete=true when stream done')
})
---
Phase 4: usePullChat Hook
Time: 1 day
Objective
Create a React hook that consumes the pull-based endpoint.
New Files
packages/framework/src/react/chat/usePullChat.ts
Interface
interface UsePullChatOptions {
  sessionId: string
  format?: 'html' | 'ansi'
  resumeFrom?: number  // For SSR handoff
  initialFrames?: Frame[]  // For SSR hydration
}
interface UsePullChatReturn {
  frames: Frame[]
  isStreaming: boolean
  error: string | null
  lastIndex: number
}
Implementation Sketch
function usePullChat(options: UsePullChatOptions): UsePullChatReturn {
  const [frames, setFrames] = useState(options.initialFrames ?? [])
  const [isStreaming, setIsStreaming] = useState(true)
  const lastIndex = useRef(options.resumeFrom ?? -1)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      while (!cancelled) {
        const res = await fetch(
          `/api/chat/${options.sessionId}/frames?after=${lastIndex.current}&wait=true`
        )
        const { frames: newFrames, lastIndex: newLast, isComplete } = await res.json()

        if (cancelled) break

        setFrames(prev => [...prev, ...newFrames.map(f => f.frame)])
        lastIndex.current = newLast

        if (isComplete) {
          setIsStreaming(false)
          break
        }
      }
    }

    poll()
    return () => { cancelled = true }
  }, [options.sessionId])

  return { frames, isStreaming, error: null, lastIndex: lastIndex.current }
}
Verification
describe('usePullChat', () => {
  it('fetches frames incrementally')
  it('stops polling when stream complete')
  it('handles network errors gracefully')
  it('supports resumeFrom for reconnection')
  it('supports initialFrames for SSR hydration')
})
---
Phase 5: Multi-Device Session Sharing
Time: 1 day
Objective
Enable multiple clients to connect to the same session.
Changes
1. Session ID generation moved to client (or returned on POST)
2. Join endpoint accepts existing session ID
3. QR code component for sharing
New API Flow
// Start chat - returns session ID
POST /api/chat/start
Body: { messages: [...] }
Response: { sessionId: "abc123" }
// Join existing session (same as pull, just different entry point)
GET /api/chat/:sessionId/frames?after=-1
React Component
function SessionQRCode({ sessionId }: { sessionId: string }) {
  const url = `${window.location.origin}/chat/join/${sessionId}`
  return <QRCode value={url} />
}
function JoinPage() {
  const { sessionId } = useParams()
  const { frames, isStreaming } = usePullChat({ sessionId })
  return <ChatUI frames={frames} isStreaming={isStreaming} />
}
Verification
describe('Multi-device session', () => {
  it('multiple clients receive same frames')
  it('late-joining client catches up from frame 0')
  it('all clients see completion simultaneously')
})
---
Phase 6: Multi-Format Rendering
Time: 1-2 days
Objective
Support HTML, ANSI, and Neovim token formats from the same frame store.
Format Conversion
function formatFrame(frame: Frame, format: 'html' | 'ansi' | 'nvim'): FormattedFrame {
  switch (format) {
    case 'html':
      return frame  // Already HTML
    case 'ansi':
      return {
        ...frame,
        blocks: frame.blocks.map(b => ({
          ...b,
          rendered: htmlToAnsi(b.rendered),
        }))
      }
    case 'nvim':
      return {
        ...frame,
        blocks: frame.blocks.map(b => ({
          ...b,
          tokens: htmlToNvimTokens(b.rendered),
        }))
      }
  }
}
Need to Build
- htmlToAnsi() - Convert HTML to ANSI codes
- htmlToNvimTokens() - Convert HTML to Neovim extmark tokens
Verification
describe('Format conversion', () => {
  it('htmlToAnsi converts bold/italic/code correctly')
  it('htmlToAnsi handles syntax highlighted code')
  it('htmlToNvimTokens produces valid extmark structure')
})
---
Phase 7: Neovim Bridge
Time: 2-3 days
Objective
Lua plugin that connects to pull endpoint and renders frames.
New Package
packages/framework-neovim/
├── lua/
│   └── chat/
│       ├── init.lua        # Plugin entry
│       ├── client.lua      # HTTP polling
│       ├── render.lua      # Extmark rendering
│       └── ui.lua          # Buffer management
├── plugin/
│   └── chat.vim            # VimL bootstrap
└── README.md
Lua Implementation Sketch
-- client.lua
local M = {}
function M.poll_frames(session_id, after_index, callback)
  local url = string.format(
    '%s/api/chat/%s/frames?after=%d&format=nvim&wait=true',
    M.base_url, session_id, after_index
  )

  -- Async HTTP request
  require('plenary.curl').get(url, {
    callback = function(response)
      local data = vim.json.decode(response.body)
      callback(data.frames, data.isComplete)
    end
  })
end
return M
Verification
- Manual testing with running server
- Show frames rendering in Neovim buffer
- Verify extmarks apply correct highlighting
---
Phase 8: Demo Polish
Time: 1-2 days
Objective
Create the demo experience.
Demo App
apps/multi-device-demo/
├── src/
│   ├── web/           # React web client
│   ├── mobile/        # React mobile-responsive
│   └── components/
│       ├── SessionQR.tsx
│       └── ChatUI.tsx
├── package.json
└── vite.config.ts
Demo Script Implementation
1. Main view shows MacBook browser
2. QR code displayed in corner
3. Phone/tablet join via QR
4. Split screen shows all devices
5. Network disconnect/reconnect demo
6. Neovim in terminal panel
Recording
- Screen recording of all 4 devices in sync
- Slow-mo on the reconnect moment
- Clean, minimal UI for demo
---
Summary Timeline
| Phase | Description | Time | Cumulative |
|-------|-------------|------|------------|
| 0 | Foundation verification | 0.5 days | 0.5 days |
| 1 | Frame store abstraction | 1-2 days | 2.5 days |
| 2 | Server-side pipeline | 1-2 days | 4.5 days |
| 3 | Pull-based endpoint | 1 day | 5.5 days |
| 4 | usePullChat hook | 1 day | 6.5 days |
| 5 | Multi-device sharing | 1 day | 7.5 days |
| 6 | Multi-format rendering | 1-2 days | 9.5 days |
| 7 | Neovim bridge | 2-3 days | 12.5 days |
| 8 | Demo polish | 1-2 days | 14.5 days |
Total: ~10-15 days to working demo
---
Questions for You
1. Scope for MVP demo: Do we need Neovim for the first demo, or would web + mobile (responsive) be enough to show the concept?
2. Frame store backend: Start with in-memory only, or also build Redis adapter in Phase 1?
3. Format conversion: Should server render all formats upfront, or on-demand per client request?
4. Session persistence: How long should sessions live? TTL? Explicit cleanup?
5. Error handling: What happens if a client falls too far behind? Catch-up limits?
