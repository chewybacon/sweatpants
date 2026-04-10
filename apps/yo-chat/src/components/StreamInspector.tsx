/**
 * StreamInspector.tsx
 *
 * Devtools-style side panel that shows raw durable stream events at the wire level.
 * Renders both live and replay events as they flow through the session.
 * Designed as a full-viewport-height column alongside the chat panel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Radio, Trash2, Filter, X } from 'lucide-react'
import type { StreamEventEntry } from '@sweatpants/framework/react/chat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Category helpers
// ---------------------------------------------------------------------------

type EventCategory = 'lifecycle' | 'text' | 'tool' | 'state' | 'error' | 'other'

const categoryColors: Record<EventCategory, string> = {
  text: 'text-blue-300',
  tool: 'text-purple-300',
  state: 'text-amber-300',
  lifecycle: 'text-slate-400',
  error: 'text-red-300',
  other: 'text-slate-500',
}

const categoryBg: Record<EventCategory, string> = {
  text: 'bg-blue-500/10',
  tool: 'bg-purple-500/10',
  state: 'bg-amber-500/10',
  lifecycle: 'bg-slate-500/10',
  error: 'bg-red-500/10',
  other: 'bg-slate-500/5',
}

function categorize(type: string): EventCategory {
  if (type.startsWith('ag_ui_text_message')) return 'text'
  if (type === 'thinking') return 'text'
  if (type.startsWith('ag_ui_tool_call')) return 'tool'
  if (type === 'isomorphic_handoff' || type === 'elicit_request') return 'tool'
  if (type.startsWith('tool_session')) return 'tool'
  if (type === 'ag_ui_run_started' || type === 'ag_ui_run_finished') return 'lifecycle'
  if (type === 'session_info') return 'lifecycle'
  if (type === 'ag_ui_checkpoint' || type === 'ag_ui_messages_snapshot' || type === 'ag_ui_state_snapshot') return 'state'
  if (type === 'error') return 'error'
  return 'other'
}

const categoryLabels: Record<EventCategory, string> = {
  text: 'Text',
  tool: 'Tool',
  state: 'State',
  lifecycle: 'Lifecycle',
  error: 'Error',
  other: 'Other',
}

const allCategories: EventCategory[] = ['lifecycle', 'text', 'tool', 'state', 'error', 'other']

// ---------------------------------------------------------------------------
// EventRow
// ---------------------------------------------------------------------------

function EventRow({
  entry,
  baseTime,
}: {
  entry: StreamEventEntry
  baseTime: number
}) {
  const [expanded, setExpanded] = useState(false)
  const category = categorize(entry.event.type)
  const relMs = entry.receivedAt - baseTime

  const shortType = entry.event.type
    .replace(/^ag_ui_/, '')
    .replace(/_/g, '_')

  return (
    <div className={cn('group border-b border-slate-800/50', categoryBg[category])}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] hover:bg-white/[0.03]"
      >
        {/* Expand chevron */}
        <span className="w-3 shrink-0 text-slate-600">
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>

        {/* LSN */}
        <span className="w-8 shrink-0 text-right tabular-nums text-slate-500">
          {String(entry.lsn).padStart(3, '0')}
        </span>

        {/* Phase badge */}
        <span
          className={cn(
            'w-14 shrink-0 rounded-full px-1.5 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wider',
            entry.phase === 'replay'
              ? 'bg-amber-500/20 text-amber-300'
              : 'bg-emerald-500/20 text-emerald-300',
          )}
        >
          {entry.phase}
        </span>

        {/* Event type */}
        <span className={cn('flex-1 truncate', categoryColors[category])}>
          {shortType}
        </span>

        {/* Relative time */}
        <span className="w-16 shrink-0 text-right tabular-nums text-slate-600">
          {relMs >= 0 ? '+' : ''}{relMs}ms
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-800/30 bg-slate-950/50 px-4 py-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-400">
            {JSON.stringify(entry.event, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StreamInspector (full-height side panel)
// ---------------------------------------------------------------------------

export interface StreamInspectorProps {
  /** The event log entries to display */
  entries: StreamEventEntry[]
  /** Whether the session is currently streaming */
  isStreaming: boolean
  /** Callback to clear the log */
  onClear: () => void
  /** Callback to close the panel */
  onClose: () => void
}

export function StreamInspector({ entries, isStreaming, onClear, onClose }: StreamInspectorProps) {
  const [enabledCategories, setEnabledCategories] = useState<Set<EventCategory>>(
    () => new Set(allCategories),
  )
  const [filterOpen, setFilterOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  // Auto-scroll to bottom when new entries arrive (unless user scrolled up)
  const prevCountRef = useRef(entries.length)
  useEffect(() => {
    if (entries.length > prevCountRef.current && !userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = entries.length
  }, [entries.length])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    userScrolledUp.current = !atBottom
  }, [])

  const toggleCategory = useCallback((cat: EventCategory) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) {
        next.delete(cat)
      } else {
        next.add(cat)
      }
      return next
    })
  }, [])

  const filtered = entries.filter((e) => enabledCategories.has(categorize(e.event.type)))
  const baseTime = entries[0]?.receivedAt ?? 0

  return (
    <div className="flex w-96 flex-none flex-col overflow-hidden rounded-[28px] border border-slate-800/80 bg-slate-950/70 shadow-2xl shadow-black/30 backdrop-blur">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-3">
        <div className="flex-1">
          <div className="text-xs uppercase tracking-[0.3em] text-sky-300/70">Inspector</div>
          <div className="flex items-center gap-2">
            <span className="font-serif text-lg text-slate-100">Stream Events</span>
            {isStreaming && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                <Radio className="size-2.5 animate-pulse" />
                Live
              </span>
            )}
          </div>
        </div>
        <span className="tabular-nums text-xs text-slate-600">
          {filtered.length}{filtered.length !== entries.length ? `/${entries.length}` : ''} events
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="rounded-lg text-slate-500 hover:text-slate-300"
          title="Close inspector"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-slate-800/50 px-3 py-1.5">
        {/* Filter dropdown */}
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilterOpen((prev) => !prev)}
            className="h-6 gap-1 px-2 text-[10px] text-slate-400 hover:text-slate-200"
          >
            <Filter className="size-3" />
            Filter
          </Button>

          {filterOpen && (
            <div className="absolute left-0 top-full z-10 mt-1 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-xl">
              {allCategories.map((cat) => (
                <label
                  key={cat}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={enabledCategories.has(cat)}
                    onChange={() => toggleCategory(cat)}
                    className="rounded border-slate-600"
                  />
                  <span className={categoryColors[cat]}>{categoryLabels[cat]}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Clear button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-6 gap-1 px-2 text-[10px] text-slate-500 hover:text-red-300"
        >
          <Trash2 className="size-3" />
          Clear
        </Button>
      </div>

      {/* Event list — fills remaining height */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-slate-600">
            {entries.length === 0
              ? 'No events yet. Send a message or refresh to see durable stream events.'
              : 'All events filtered out.'}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <EventRow key={`${entry.lsn}-${entry.phase}-${i}`} entry={entry} baseTime={baseTime} />
          ))
        )}
      </div>
    </div>
  )
}
