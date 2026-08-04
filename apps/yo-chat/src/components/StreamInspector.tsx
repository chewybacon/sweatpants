import { useCallback, useEffect, useState } from "react";

interface StreamFrame {
  readonly lsn: number;
  readonly event: { readonly type?: string; readonly [key: string]: unknown };
}

interface StreamInspectorProps {
  readonly threadId: string;
}

function parseFrames(text: string): StreamFrame[] {
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
        const eventValue = frame["event"];
        if (
          typeof frame["lsn"] !== "number" ||
          !Number.isSafeInteger(frame["lsn"]) ||
          typeof eventValue !== "object" ||
          eventValue === null ||
          Array.isArray(eventValue)
        ) {
          return [];
        }
        return [
          {
            lsn: frame["lsn"],
            event: eventValue as StreamFrame["event"],
          },
        ];
      } catch {
        return [];
      }
    });
}

export function StreamInspector({ threadId }: StreamInspectorProps) {
  const [frames, setFrames] = useState<readonly StreamFrame[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/chat?conversationId=${encodeURIComponent(threadId)}`, {
        headers: { Accept: "application/x-ndjson" },
      });
      if (!response.ok) {
        throw new Error(`Stream request failed (${response.status})`);
      }
      setFrames(parseFrames(await response.text()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setFrames([]);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setFrames([]);
    setError(null);
  }, [threadId]);

  return (
    <details
      className="border-b border-slate-800/80 bg-slate-950/70"
      data-testid="stream-inspector"
    >
      <summary className="cursor-pointer px-5 py-3 text-xs uppercase tracking-[0.25em] text-slate-400">
        Stream Inspector
      </summary>
      <div className="space-y-3 px-5 pb-4">
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>{frames.length} replay frame(s)</span>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-sky-400 hover:text-sky-200 disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Loading..." : "Reload stream"}
          </button>
        </div>
        {error && <div className="text-xs text-red-300">{error}</div>}
        {frames.length > 0 && (
          <ol className="max-h-72 space-y-2 overflow-y-auto font-mono text-[11px]">
            {frames.map((frame) => (
              <li
                key={`${frame.lsn}:${frame.event.type ?? "unknown"}`}
                className="rounded border border-slate-800 bg-slate-900/80 p-2"
              >
                <div className="mb-1 flex gap-3 text-sky-300">
                  <span>lsn={frame.lsn}</span>
                  <span>{frame.event.type ?? "UNKNOWN"}</span>
                </div>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-slate-500">
                  {JSON.stringify(frame.event, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
