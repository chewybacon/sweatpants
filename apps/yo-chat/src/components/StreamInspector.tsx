import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Filter, Radio, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InspectorEventEntry, StreamInspectorStore } from "@/lib/stream-inspector";
import { Button } from "@/components/ui/button";

type EventCategory = "lifecycle" | "text" | "tool" | "state" | "error" | "other";

const categoryColors: Record<EventCategory, string> = {
  text: "text-blue-300",
  tool: "text-purple-300",
  state: "text-amber-300",
  lifecycle: "text-slate-400",
  error: "text-red-300",
  other: "text-slate-500",
};

const categoryBackgrounds: Record<EventCategory, string> = {
  text: "bg-blue-500/10",
  tool: "bg-purple-500/10",
  state: "bg-amber-500/10",
  lifecycle: "bg-slate-500/10",
  error: "bg-red-500/10",
  other: "bg-slate-500/5",
};

const categoryLabels: Record<EventCategory, string> = {
  text: "Text",
  tool: "Tool",
  state: "State",
  lifecycle: "Lifecycle",
  error: "Error",
  other: "Other",
};

const allCategories: readonly EventCategory[] = [
  "lifecycle",
  "text",
  "tool",
  "state",
  "error",
  "other",
];

function categorize(type: string): EventCategory {
  if (type.includes("TEXT_MESSAGE") || type.includes("REASONING_MESSAGE")) {
    return "text";
  }
  if (type.includes("TOOL_CALL") || type.includes("ACTIVITY")) {
    return "tool";
  }
  if (type.includes("RUN_STARTED") || type.includes("RUN_FINISHED")) {
    return "lifecycle";
  }
  if (type.includes("SNAPSHOT") || type.includes("DELTA")) {
    return "state";
  }
  if (type.includes("ERROR")) {
    return "error";
  }
  return "other";
}

function EventRow({ entry, baseTime }: { entry: InspectorEventEntry; baseTime: number }) {
  const [expanded, setExpanded] = useState(false);
  const category = categorize(entry.event.type);
  const relativeMs = entry.receivedAt - baseTime;

  return (
    <div className={cn("group border-b border-slate-800/50", categoryBackgrounds[category])}>
      <button
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] hover:bg-white/[0.03]"
      >
        <span className="w-3 shrink-0 text-slate-600">
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <span className="w-8 shrink-0 text-right tabular-nums text-slate-500">
          {String(entry.sequence).padStart(3, "0")}
        </span>
        <span
          className={cn(
            "w-14 shrink-0 rounded-full px-1.5 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wider",
            entry.phase === "replay"
              ? "bg-amber-500/20 text-amber-300"
              : "bg-emerald-500/20 text-emerald-300",
          )}
        >
          {entry.phase}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", categoryColors[category])}>
          {entry.event.type}
        </span>
        <span className="w-16 shrink-0 text-right tabular-nums text-slate-600">
          {relativeMs >= 0 ? "+" : ""}
          {relativeMs}ms
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
  );
}

export interface StreamInspectorProps {
  readonly threadId: string;
  readonly store: StreamInspectorStore;
  readonly onClose: () => void;
}

export function StreamInspector({ threadId, store, onClose }: StreamInspectorProps) {
  const entries = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [enabledCategories, setEnabledCategories] = useState<ReadonlySet<EventCategory>>(
    () => new Set(allCategories),
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const previousCount = useRef(0);

  useEffect(() => {
    if (entries.length > previousCount.current && !userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    previousCount.current = entries.length;
  }, [entries.length]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    userScrolledUp.current = !atBottom;
  }, []);

  const toggleCategory = useCallback((category: EventCategory) => {
    setEnabledCategories((previous) => {
      const next = new Set(previous);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    store.clear();
    userScrolledUp.current = false;
    previousCount.current = 0;
  }, [store]);

  const filtered = entries.filter((entry) => enabledCategories.has(categorize(entry.event.type)));
  const baseTime = entries[0]?.receivedAt ?? 0;
  const isLive = entries.some((entry) => entry.phase === "live");

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-background"
      data-testid="stream-inspector"
      data-thread-id={threadId}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800/80 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-[0.3em] text-sky-300/70">Inspector</div>
          <div className="flex items-center gap-2">
            <span className="text-base text-slate-100">Stream Events</span>
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                isLive ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300",
              )}
            >
              <Radio className={cn("size-2.5", isLive && "animate-pulse")} />
              {isLive ? "Live" : "Replay"}
            </span>
          </div>
        </div>
        <span className="shrink-0 tabular-nums text-xs text-slate-600">
          {filtered.length}
          {filtered.length !== entries.length ? `/${entries.length}` : ""} events
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

      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800/50 px-3 py-1.5">
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilterOpen((previous) => !previous)}
            className="h-6 gap-1 px-2 text-[10px] text-slate-400 hover:text-slate-200"
          >
            <Filter className="size-3" />
            Filter
          </Button>
          {filterOpen && (
            <div className="absolute left-0 top-full z-10 mt-1 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-xl">
              {allCategories.map((category) => (
                <label
                  key={category}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={enabledCategories.has(category)}
                    onChange={() => toggleCategory(category)}
                    className="rounded border-slate-600"
                  />
                  <span className={categoryColors[category]}>{categoryLabels[category]}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          onClick={clear}
          className="h-6 gap-1 px-2 text-[10px] text-slate-500 hover:text-red-300"
        >
          <Trash2 className="size-3" />
          Clear
        </Button>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-slate-600">
            {entries.length === 0
              ? "No events yet. Send a message to see the live stream."
              : "All events filtered out."}
          </div>
        ) : (
          filtered.map((entry) => (
            <EventRow
              key={`${entry.sequence}:${entry.event.type}`}
              entry={entry}
              baseTime={baseTime}
            />
          ))
        )}
      </div>
    </div>
  );
}
