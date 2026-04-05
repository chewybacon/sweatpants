import { createFileRoute } from '@tanstack/react-router'
import { MessageCirclePlus, PanelLeftOpen, RefreshCcw } from 'lucide-react'
import { useChat, type ChatMessage, type ChatToolCall } from '@sweatpants/framework/react/chat'
import { useChatSession } from '@sweatpants/framework/react/chat'
import { createPipelineTransform } from '@sweatpants/framework/react/chat/pipeline'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tools } from '@/__generated__/tool-registry.gen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ThreadSummary } from '@/lib/threaded-chat-types'

type ReplayableEmission = {
  id: string
  status: 'pending' | 'complete'
  component: React.ComponentType<any>
  props: Record<string, unknown>
  response?: unknown
  onRespond?: (value: unknown) => void
}

function toReplayableEmission(emission: {
  id: string
  status: 'pending' | 'complete' | 'error'
  payload: { _component?: React.ComponentType<any>; props: Record<string, unknown> }
  response?: unknown
  respond?: (value: unknown) => void
}): ReplayableEmission | null {
  const component = emission.payload._component
  if (!component) {
    return null
  }

  return {
    id: emission.id,
    status: emission.status === 'error' ? 'complete' : emission.status,
    component,
    props: emission.payload.props,
    ...(emission.response !== undefined ? { response: emission.response } : {}),
    ...(emission.respond ? { onRespond: emission.respond } : {}),
  }
}

export const Route = createFileRoute('/chat/threaded/')({
  component: ThreadedChatDemo,
})

const THREAD_STORAGE_KEY = 'threaded-chat-selected-thread-id'

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function shortThreadId(threadId: string): string {
  return threadId.slice(0, 8)
}

function summarizeThread(threadId: string, messages: ChatMessage[]): Pick<ThreadSummary, 'title' | 'lastMessagePreview' | 'messageCount'> {
  const visibleMessages = messages.filter((message) => message.role === 'user' || message.role === 'assistant')
  const titleSource = visibleMessages.find((message) => message.role === 'user')
  const lastSource = visibleMessages[visibleMessages.length - 1]
  const title = compact(titleSource ? getMessagePlainText(titleSource) : '') || 'New thread'
  const preview = compact(lastSource ? getMessagePlainText(lastSource) : '') || 'No messages yet'

  return {
    title: title.length > 40 ? `${title.slice(0, 37)}...` : title,
    lastMessagePreview: preview.length > 80 ? `${preview.slice(0, 77)}...` : preview,
    messageCount: visibleMessages.length,
  }
}

function getMessagePlainText(message: ChatMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === 'text' || part.type === 'reasoning') {
        return part.content
      }
      if (part.type === 'tool-call') {
        if (typeof part.result === 'string') {
          return part.result
        }
        return ''
      }
      return ''
    })
    .join('\n')
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

async function updateThread(threadId: string, payload: Partial<Pick<ThreadSummary, 'title' | 'lastMessagePreview' | 'messageCount'>>): Promise<ThreadSummary> {
  const response = await fetch(`/api/threaded-chat/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`Failed to update thread (${response.status})`)
  }
  const data = (await response.json()) as { thread: ThreadSummary }
  return data.thread
}

function ToolCallBlock({ toolCall }: { toolCall: ChatToolCall }) {
  const hasEmissions = toolCall.emissions.length > 0

  return (
    <div className="my-3 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.25em] text-sky-300/70">
        Tool · {toolCall.name}
      </div>

      {toolCall.emissions.map((emission) => {
        const Component = emission.component
        if (!Component) return null

        return (
          <Component
            key={emission.id}
            {...emission.props}
            onRespond={emission.onRespond}
            disabled={emission.status !== 'pending'}
            response={emission.response}
          />
        )
      })}

      {!hasEmissions && (toolCall.state === 'running' || toolCall.state === 'pending') && (
        <div className="text-xs text-slate-500 animate-pulse">Running {toolCall.name}...</div>
      )}

      {toolCall.state === 'error' && toolCall.error && (
        <div className="text-xs text-red-300">Error: {toolCall.error}</div>
      )}
    </div>
  )
}

function HistoricalToolCallBlock({
  toolCall,
  replayed,
}: {
  toolCall: ChatToolCall
  replayed: Record<string, ReplayableEmission[]>
}) {
  const replayedEmissions = replayed[toolCall.callId] ?? []
  const emissions = toolCall.emissions.length > 0 ? toolCall.emissions : replayedEmissions
  const hasEmissions = emissions.length > 0

  return (
    <div className="my-3 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.25em] text-sky-300/70">
        Tool · {toolCall.name}
      </div>

      {emissions.map((emission) => {
        const Component = emission.component
        if (!Component) return null

        return (
          <Component
            key={emission.id}
            {...emission.props}
            onRespond={emission.onRespond}
            disabled={emission.status !== 'pending'}
            response={emission.response}
          />
        )
      })}

      {!hasEmissions && (toolCall.state === 'running' || toolCall.state === 'pending') && (
        <div className="text-xs text-slate-500 animate-pulse">Running {toolCall.name}...</div>
      )}

      {toolCall.state === 'error' && toolCall.error && (
        <div className="text-xs text-red-300">Error: {toolCall.error}</div>
      )}
    </div>
  )
}

function useThreadReplaySession(threadId: string) {
  const session = useChatSession({
    transforms: [createPipelineTransform({ processors: 'markdown' })],
    tools: [tools.pickCard],
    conversationId: threadId,
  })

  const toolEmissionsByCallId = useMemo(() => {
    return session.toolEmissions.reduce<Record<string, ReplayableEmission[]>>((acc, tracking) => {
      acc[tracking.callId] = tracking.emissions
        .map(toReplayableEmission)
        .filter((emission): emission is ReplayableEmission => emission !== null)
      return acc
    }, {})
  }, [session.toolEmissions])

  return {
    toolEmissionsByCallId,
  }
}

function MessageBubble({
  message,
  replayedToolEmissions,
}: {
  message: ChatMessage
  replayedToolEmissions: Record<string, ReplayableEmission[]>
}) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-3xl rounded-[24px] px-5 py-4 shadow-lg ${isUser ? 'bg-amber-300 text-slate-950 shadow-amber-500/10' : 'border border-slate-800 bg-slate-900/90 text-slate-100 shadow-black/20'}`}>
        <div className={`mb-2 text-[11px] uppercase tracking-[0.28em] ${isUser ? 'text-slate-800/70' : 'text-sky-300/70'}`}>
          {isUser ? 'You' : 'Assistant'}
          {message.isStreaming ? ' - streaming' : ''}
        </div>

        {message.parts.map((part) => {
          if (part.type === 'reasoning') {
            return (
              <details key={part.id} className="mb-3 text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-400">Thinking...</summary>
                <div className="mt-2 rounded bg-slate-950/80 p-2 text-slate-400 italic" dangerouslySetInnerHTML={{ __html: part.rendered }} />
              </details>
            )
          }

          if (part.type === 'tool-call') {
            return <HistoricalToolCallBlock key={part.id} toolCall={part} replayed={replayedToolEmissions} />
          }

          if (part.type === 'text') {
            return (
              <div
                key={part.id}
                className={`prose prose-sm max-w-none leading-7 ${isUser ? 'prose-stone' : 'prose-invert'}`}
                dangerouslySetInnerHTML={{ __html: part.rendered }}
              />
            )
          }

          return null
        })}
      </div>
    </div>
  )
}

function ThreadPanel({
  threadId,
  onMetadata,
}: {
  threadId: string
  onMetadata: (threadId: string, summary: Pick<ThreadSummary, 'title' | 'lastMessagePreview' | 'messageCount'>) => void
}) {
  const [draft, setDraft] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const {
    messages,
    isStreaming,
    pipelineReady,
    send,
    abort,
    error,
  } = useChat({
    pipeline: 'markdown',
    tools: [tools.pickCard],
    conversationId: threadId,
  })
  const { toolEmissionsByCallId } = useThreadReplaySession(threadId)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    onMetadata(threadId, summarizeThread(threadId, messages))
  }, [messages, onMetadata, threadId])

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault()
    const content = draft.trim()
    if (!content || isStreaming) {
      return
    }
    send(content)
    setDraft('')
  }, [draft, isStreaming, send])

  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.3em] text-sky-300/70">Durable Threads</div>
            <div className="font-serif text-xl text-slate-100">{pipelineReady ? 'Thread ready' : 'Loading thread'}</div>
          </div>
        </div>
        <div className="rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-xs text-sky-200">
          {threadId}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-slate-400">
            <div className="rounded-full border border-amber-200/10 bg-amber-200/5 px-4 py-1 text-xs uppercase tracking-[0.35em] text-amber-200/70">Empty Thread</div>
            <h2 className="font-serif text-3xl text-slate-100">Start a durable conversation</h2>
            <p className="max-w-md text-sm leading-6">Ask for a card, pick one, refresh, and keep going in the same thread.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} replayedToolEmissions={toolEmissionsByCallId} />
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
            placeholder="Ask this thread to draw a card..."
            disabled={isStreaming}
            className="h-14 rounded-2xl border-slate-700 bg-slate-900/90 px-5 text-base"
          />
          {isStreaming ? (
            <Button type="button" onClick={abort} className="h-14 rounded-2xl bg-red-500 px-6 text-white hover:bg-red-400">
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!draft.trim()}
              className="h-14 rounded-2xl bg-sky-500 px-6 text-white hover:bg-sky-400"
            >
              Send
            </Button>
          )}
        </form>
      </div>
    </>
  )
}

function ThreadedChatDemo() {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

      setThreads(nextThreads)
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

  const handleNewThread = useCallback(async () => {
    try {
      setError(null)
      const created = await createThread()
      setThreads((previous) => [created, ...previous])
      setSelectedThreadId(created.id)
      persistSelection(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create thread')
    }
  }, [persistSelection])

  const handleSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId)
    persistSelection(threadId)
  }, [persistSelection])

  const handleMetadata = useCallback((threadId: string, summary: Pick<ThreadSummary, 'title' | 'lastMessagePreview' | 'messageCount'>) => {
    setThreads((previous) => {
      const existing = previous.find((thread) => thread.id === threadId)
      const optimisticUpdatedAt = Date.now()

      const nextThread: ThreadSummary = existing
        ? {
            ...existing,
            ...summary,
            updatedAt: optimisticUpdatedAt,
          }
        : {
            id: threadId,
            createdAt: optimisticUpdatedAt,
            updatedAt: optimisticUpdatedAt,
            ...summary,
          }

      const next = previous.some((thread) => thread.id === threadId)
        ? previous.map((thread) => (thread.id === threadId ? nextThread : thread))
        : [nextThread, ...previous]

      return [...next].sort((a, b) => b.updatedAt - a.updatedAt)
    })

    void updateThread(threadId, summary).then((thread) => {
      setThreads((previous) => {
        const next = previous.some((item) => item.id === thread.id)
          ? previous.map((item) => (item.id === thread.id ? thread : item))
          : [thread, ...previous]
        return [...next].sort((a, b) => b.updatedAt - a.updatedAt)
      })
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to sync thread metadata')
    })
  }, [])

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
              <span data-testid="thread-create" className="contents">
              <MessageCirclePlus className="size-4" />
              New thread
              </span>
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
                data-testid="thread-item"
                data-thread-id={thread.id}
                aria-pressed={selectedThreadId === thread.id}
                onClick={() => handleSelectThread(thread.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition ${selectedThreadId === thread.id ? 'border-amber-300 bg-amber-100/15 ring-2 ring-amber-300/40 shadow-lg shadow-amber-500/20' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="truncate font-medium text-slate-100">{thread.title}</div>
                  <div className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ${selectedThreadId === thread.id ? 'bg-amber-300 text-slate-950' : 'border border-slate-700 text-slate-500'}`}>
                    {selectedThreadId === thread.id ? 'Active' : shortThreadId(thread.id)}
                  </div>
                </div>
                <div className="line-clamp-2 text-xs text-slate-400">{thread.lastMessagePreview}</div>
                <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-slate-500">
                  <span>{thread.messageCount} messages</span>
                  <span>{shortThreadId(thread.id)}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-[82vh] flex-1 flex-col overflow-hidden rounded-[32px] border border-slate-800/80 bg-slate-950/75 shadow-2xl shadow-black/30 backdrop-blur">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4 md:hidden">
            <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen((open) => !open)}>
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>

          {loading || !selectedThreadId ? (
            <div className="flex h-full items-center justify-center text-slate-400">Loading threads...</div>
          ) : (
            <ThreadPanel
              key={selectedThreadId}
              threadId={selectedThreadId}
              onMetadata={handleMetadata}
            />
          )}

          {error && (
            <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200 md:px-6">
              {error}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
