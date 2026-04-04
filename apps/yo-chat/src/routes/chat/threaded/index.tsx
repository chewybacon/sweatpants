import { createFileRoute } from '@tanstack/react-router'
import { MessageCirclePlus, PanelLeftOpen, RefreshCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  deriveThreadMessages,
  summarizeThreadFromEvents,
  type ThreadEvent,
  type ThreadFrame,
  type ThreadSummary,
} from '@/lib/threaded-chat-types'

export const Route = createFileRoute('/chat/threaded/')({
  component: ThreadedChatDemo,
})

const THREAD_STORAGE_KEY = 'threaded-chat-selected-thread-id'

async function readFrames(response: Response): Promise<ThreadFrame[]> {
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }
  return trimmed.split('\n').map((line) => JSON.parse(line) as ThreadFrame)
}

async function listThreads(): Promise<ThreadSummary[]> {
  const response = await fetch('/api/threaded-chat/threads')
  if (!response.ok) {
    throw new Error(`Failed to list threads (${response.status})`)
  }
  const data = (await response.json()) as { threads: ThreadSummary[] }
  return data.threads
}

async function createThread(): Promise<ThreadSummary> {
  const response = await fetch('/api/threaded-chat/threads', { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Failed to create thread (${response.status})`)
  }
  const data = (await response.json()) as { thread: ThreadSummary }
  return data.thread
}

async function loadThread(threadId: string): Promise<ThreadEvent[]> {
  const response = await fetch(`/api/threaded-chat/threads/${encodeURIComponent(threadId)}`)
  if (!response.ok) {
    throw new Error(`Failed to load thread (${response.status})`)
  }
  const frames = await readFrames(response)
  return frames.map((frame) => frame.event)
}

async function sendThreadMessage(threadId: string, content: string): Promise<ThreadEvent[]> {
  const response = await fetch(`/api/threaded-chat/threads/${encodeURIComponent(threadId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content }],
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to send message (${response.status})`)
  }

  const frames = await readFrames(response)
  return frames.map((frame) => frame.event)
}

function ThreadedChatDemo() {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [eventsByThread, setEventsByThread] = useState<Record<string, ThreadEvent[]>>({})
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const persistSelection = useCallback((threadId: string | null) => {
    if (typeof window === 'undefined') {
      return
    }
    if (threadId) {
      window.localStorage.setItem(THREAD_STORAGE_KEY, threadId)
    } else {
      window.localStorage.removeItem(THREAD_STORAGE_KEY)
    }
  }, [])

  const selectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId)
    persistSelection(threadId)
  }, [persistSelection])

  const hydrate = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      let nextThreads = await listThreads()
      let nextSelected = typeof window !== 'undefined'
        ? window.localStorage.getItem(THREAD_STORAGE_KEY)
        : null

      if (nextThreads.length === 0) {
        const created = await createThread()
        nextThreads = [created]
        nextSelected = created.id
      }

      if (!nextSelected || !nextThreads.some((thread) => thread.id === nextSelected)) {
        nextSelected = nextThreads[0]?.id ?? null
      }

      const nextEventsEntries = await Promise.all(
        nextThreads.map(async (thread) => [thread.id, await loadThread(thread.id)] as const),
      )

      setThreads(nextThreads)
      setEventsByThread(Object.fromEntries(nextEventsEntries))
      setSelectedThreadId(nextSelected)
      persistSelection(nextSelected)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load threaded chat')
    } finally {
      setLoading(false)
    }
  }, [persistSelection])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [selectedThreadId, eventsByThread])

  const selectedEvents = selectedThreadId ? (eventsByThread[selectedThreadId] ?? []) : []
  const messages = useMemo(() => deriveThreadMessages(selectedEvents), [selectedEvents])

  const refreshThreadList = useCallback((threadId: string, events: ThreadEvent[]) => {
    const summary = summarizeThreadFromEvents(threadId, events)
    setThreads((previous) => {
      const next = previous.some((thread) => thread.id === threadId)
        ? previous.map((thread) => (thread.id === threadId ? summary : thread))
        : [summary, ...previous]
      return [...next].sort((a, b) => b.updatedAt - a.updatedAt)
    })
  }, [])

  const handleNewThread = useCallback(async () => {
    try {
      setError(null)
      const created = await createThread()
      setThreads((previous) => [created, ...previous])
      setEventsByThread((previous) => ({ ...previous, [created.id]: [] }))
      selectThread(created.id)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create thread')
    }
  }, [selectThread])

  const handleSelectThread = useCallback(async (threadId: string) => {
    selectThread(threadId)
    if (eventsByThread[threadId]) {
      return
    }

    try {
      const events = await loadThread(threadId)
      setEventsByThread((previous) => ({ ...previous, [threadId]: events }))
      refreshThreadList(threadId, events)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread')
    }
  }, [eventsByThread, refreshThreadList, selectThread])

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    const content = draft.trim()
    if (!selectedThreadId || !content || sending) {
      return
    }

    setSending(true)
    setError(null)

    try {
      const streamedEvents = await sendThreadMessage(selectedThreadId, content)
      setEventsByThread((previous) => {
        const nextEvents = [...(previous[selectedThreadId] ?? []), ...streamedEvents]
        refreshThreadList(selectedThreadId, nextEvents)
        return {
          ...previous,
          [selectedThreadId]: nextEvents,
        }
      })
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }, [draft, refreshThreadList, selectedThreadId, sending])

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.16),_transparent_30%),linear-gradient(180deg,_#0f172a_0%,_#111827_52%,_#0b1220_100%)] text-slate-100">
      <div className="mx-auto flex min-h-[calc(100vh-64px)] max-w-7xl flex-col gap-4 p-4 md:flex-row md:p-6">
        <aside className={cn(
          'w-full shrink-0 flex-col rounded-[28px] border border-amber-200/10 bg-slate-950/70 p-4 shadow-2xl shadow-black/30 backdrop-blur md:flex md:w-80',
          sidebarOpen ? 'flex' : 'hidden',
        )}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.35em] text-amber-300/70">Prototype</div>
              <h1 className="font-serif text-2xl text-amber-50">Threaded Chat</h1>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(false)} className="md:hidden">
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>

          <div className="mb-4 flex gap-2">
            <Button onClick={() => void handleNewThread()} className="flex-1 bg-amber-400 text-slate-950 hover:bg-amber-300">
              <MessageCirclePlus className="size-4" />
              New thread
            </Button>
            <Button variant="outline" size="icon" onClick={() => void hydrate()}>
              <RefreshCcw className="size-4" />
            </Button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => void handleSelectThread(thread.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition ${selectedThreadId === thread.id ? 'border-amber-300/50 bg-amber-100/10 shadow-lg shadow-amber-500/10' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'}`}
              >
                <div className="mb-1 truncate font-medium text-slate-100">{thread.title}</div>
                <div className="line-clamp-2 text-xs text-slate-400">{thread.lastMessagePreview}</div>
                <div className="mt-3 text-[11px] uppercase tracking-[0.25em] text-slate-500">{thread.messageCount} messages</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-[82vh] flex-1 flex-col overflow-hidden rounded-[32px] border border-slate-800/80 bg-slate-950/75 shadow-2xl shadow-black/30 backdrop-blur">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen((open) => !open)}>
                <PanelLeftOpen className="size-4" />
              </Button>
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-sky-300/70">Durable Threads</div>
                <div className="font-serif text-xl text-slate-100">
                  {threads.find((thread) => thread.id === selectedThreadId)?.title ?? 'Loading thread'}
                </div>
              </div>
            </div>
            <div className="rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-xs text-sky-200">
              {selectedThreadId ?? 'no-thread'}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
            {loading ? (
              <div className="flex h-full items-center justify-center text-slate-400">Loading threads...</div>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-slate-400">
                <div className="rounded-full border border-amber-200/10 bg-amber-200/5 px-4 py-1 text-xs uppercase tracking-[0.35em] text-amber-200/70">Empty Thread</div>
                <h2 className="font-serif text-3xl text-slate-100">Start a durable conversation</h2>
                <p className="max-w-md text-sm leading-6">This prototype keeps one durable thread id per conversation. Refresh the page, switch threads, and come back without losing the transcript.</p>
              </div>
            ) : (
              <div className="space-y-6">
                {messages.map((message) => (
                  <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-3xl rounded-[24px] px-5 py-4 shadow-lg ${message.role === 'user' ? 'bg-amber-300 text-slate-950 shadow-amber-500/10' : 'border border-slate-800 bg-slate-900/90 text-slate-100 shadow-black/20'}`}>
                      <div className={`mb-2 text-[11px] uppercase tracking-[0.28em] ${message.role === 'user' ? 'text-slate-800/70' : 'text-sky-300/70'}`}>
                        {message.role === 'user' ? 'You' : 'Assistant'}
                        {message.isStreaming ? ' - streaming' : ''}
                      </div>
                      <div className="whitespace-pre-wrap text-sm leading-7">{message.content}</div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="border-t border-slate-800/80 bg-slate-950/90 px-4 py-4 md:px-6">
            {error && (
              <div className="mb-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col gap-3 md:flex-row">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Send a message to the current durable thread..."
                disabled={!selectedThreadId || sending || loading}
                className="h-14 rounded-2xl border-slate-700 bg-slate-900/90 px-5 text-base"
              />
              <Button
                type="submit"
                disabled={!selectedThreadId || sending || !draft.trim() || loading}
                className="h-14 rounded-2xl bg-sky-500 px-6 text-white hover:bg-sky-400"
              >
                {sending ? 'Sending...' : 'Send'}
              </Button>
            </form>
          </div>
        </main>
      </div>
    </div>
  )
}
