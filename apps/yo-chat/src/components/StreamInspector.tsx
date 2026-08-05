import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Filter, Radio, RefreshCcw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type EventCategory = "lifecycle" | "text" | "tool" | "state" | "error" | "other";

type StreamFrame = {
  readonly lsn: number;
  readonly event: { readonly type: string; readonly [key: string]: unknown };
  readonly phase: "replay";
  readonly receivedAt: number;
};

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

function parseFrames(text: string, receivedAt: number): StreamFrame[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return [];
        }
        const frame = value as Record<string, unknown>;
        const event = frame["event"];
        if (
          typeof frame["lsn"] !== "number" ||
          !Number.isSafeInteger(frame["lsn"]) ||
          typeof event !== "object" ||
          event === null ||
          Array.isArray(event) ||
          typeof (event as Record<string, unknown>)["type"] !== "string"
        ) {
          return [];
        }
        return [
          {
            lsn: frame["lsn"] as number,
            event: event as StreamFrame["event"],
            phase: "replay" as const,
            receivedAt,
          },
        ];
      } catch {
        return [];
      }
    });
}

function EventRow({ entry, baseTime }: { entry: StreamFrame; baseTime: number }) {
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
          {String(entry.lsn).padStart(3, "0")}
        </span>
        <span className="w-14 shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wider text-amber-300">
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
  readonly refreshKey?: number | string;
  readonly onClose: () => void;
}

export function StreamInspector({ threadId, refreshKey, onClose }: StreamInspectorProps) {
  const [frames, setFrames] = useState<readonly StreamFrame[]>([]);
  const [enabledCategories, setEnabledCategories] = useState<ReadonlySet<EventCategory>>(
    () => new Set(allCategories),
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const previousCount = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/chat?conversationId=${encodeURIComponent(threadId)}`, {
        headers: { Accept: "application/x-ndjson" },
      });
      if (response.status === 404) {
        setFrames([]);
        return;
      }
      if (!response.ok) {
        throw new Error(`Stream request failed (${response.status})`);
      }
      setFrames(parseFrames(await response.text(), Date.now()));
      userScrolledUp.current = false;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setFrames([]);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (frames.length > previousCount.current && !userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    previousCount.current = frames.length;
  }, [frames.length]);

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
    setFrames([]);
    setError(null);
    previousCount.current = 0;
  }, []);

  const filtered = frames.filter((frame) => enabledCategories.has(categorize(frame.event.type)));
  const baseTime = frames[0]?.receivedAt ?? 0;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-none flex-col overflow-hidden rounded-[28px] border border-slate-800/80 bg-slate-950/70 shadow-2xl shadow-black/30 backdrop-blur md:w-96"
      data-testid="stream-inspector"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800/80 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-[0.3em] text-sky-300/70">Inspector</div>
          <div className="flex items-center gap-2">
            <span className="font-serif text-lg text-slate-100">Stream Events</span>
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              <Radio className="size-2.5" />
              Replay
            </span>
          </div>
        </div>
        <span className="shrink-0 tabular-nums text-xs text-slate-600">
          {filtered.length}
          {filtered.length !== frames.length ? `/${frames.length}` : ""} events
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

        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload()}
          disabled={loading}
          className="h-6 gap-1 px-2 text-[10px] text-slate-400 hover:text-slate-200"
        >
          <RefreshCcw className={cn("size-3", loading && "animate-spin")} />
          Reload
        </Button>

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

      {error && <div className="shrink-0 px-4 py-2 text-xs text-red-300">{error}</div>}

      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-slate-600">
            {frames.length === 0
              ? "No replay frames yet. Send a message or reload this thread."
              : "All events filtered out."}
          </div>
        ) : (
          filtered.map((frame) => (
            <EventRow key={`${frame.lsn}:${frame.event.type}`} entry={frame} baseTime={baseTime} />
          ))
        )}
      </div>
    </div>
  );
}
