import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/lab/durability/journal")({
  component: ProgramJournalInspector,
});

type Inspection = {
  conversationId: string;
  recordCount: number;
  summary: {
    taskCount: number;
    pendingPullIds: string[];
    recordsByType: Record<string, number>;
  };
  records: Array<{
    offset: string;
    eventId: string;
    payload: { type?: string; taskId?: string; [key: string]: unknown };
  }>;
};

function ProgramJournalInspector() {
  const [hydrated, setHydrated] = useState(false);
  const [inspection, setInspection] = useState<Inspection>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = String(new FormData(event.currentTarget).get("conversationId") ?? "").trim();
    if (!selected) {
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/dev/journals/${encodeURIComponent(selected)}`);
      const body = (await response.json()) as Inspection | { error?: string };
      if (!response.ok || !("records" in body)) {
        throw new Error("error" in body && body.error ? body.error : `HTTP ${response.status}`);
      }
      setInspection(body);
    } catch (cause) {
      setInspection(undefined);
      setError(cause instanceof Error ? cause.message : "Unable to inspect journal");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 px-6 py-10">
      <div className="mx-auto max-w-6xl">
        <Link to="/lab/durability" className="text-cyan-400 hover:underline">
          ← Durability Lab
        </Link>
        <h1 className="mt-4 text-3xl font-bold">ProgramDriver Journal Inspector</h1>
        <p className="mt-2 text-slate-400">
          Inspect the redacted semantic journal for a known durable conversation ID.
        </p>

        <form onSubmit={inspect} className="mt-6 flex gap-3">
          <input
            name="conversationId"
            placeholder="conversation ID"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono"
          />
          <button
            type="submit"
            disabled={loading || !hydrated}
            className="rounded bg-cyan-600 px-4 py-2 font-medium disabled:opacity-50"
          >
            {loading ? "Loading…" : "Inspect"}
          </button>
        </form>

        {error ? <p className="mt-4 text-red-400">{error}</p> : null}
        {inspection ? <Journal inspection={inspection} /> : null}
      </div>
    </main>
  );
}

function Journal({ inspection }: { inspection: Inspection }) {
  return (
    <section className="mt-8 space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Records" value={inspection.recordCount} />
        <Stat label="Tasks" value={inspection.summary.taskCount} />
        <Stat label="Pending pulls" value={inspection.summary.pendingPullIds.length} />
      </div>

      <div className="rounded border border-slate-800 bg-slate-900 p-4">
        <h2 className="font-semibold">Record types</h2>
        <pre className="mt-2 overflow-auto text-xs text-slate-300">
          {JSON.stringify(inspection.summary.recordsByType, null, 2)}
        </pre>
      </div>

      <ol className="space-y-3">
        {inspection.records.map((record) => (
          <li key={record.eventId} className="rounded border border-slate-800 bg-slate-900 p-4">
            <div className="flex flex-wrap gap-x-4 text-sm">
              <strong className="text-cyan-300">{record.payload.type ?? "unknown"}</strong>
              <span className="text-slate-500">offset {record.offset}</span>
              {record.payload.taskId ? (
                <span className="font-mono text-slate-400">{record.payload.taskId}</span>
              ) : null}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-slate-400">Raw record</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-slate-950 p-3 text-xs">
                {JSON.stringify(record, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900 p-4">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
