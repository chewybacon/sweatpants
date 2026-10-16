import { useEffect, useState } from "react";
import { CheckpointSummary } from "./CheckpointSummary.tsx";
import { executionViewSchema, type ExecutionView } from "./contract.ts";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export function ExecutionInspector() {
  const [view, setView] = useState<ExecutionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"state" | "source">("state");
  async function request(action?: string, choice?: string) {
    setBusy(true);
    setError(null);
    try {
      const id = view?.id ?? new URL(location.href).searchParams.get("run");
      const response = await fetch(
        action ? "/api/execution" : `/api/execution?id=${encodeURIComponent(id ?? "")}`,
        action
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, choice, id, revision: view?.revision }),
            }
          : undefined,
      );
      const data: unknown = await response.json();
      if (!response.ok)
        throw Error(
          typeof data === "object" && data && "error" in data
            ? String(data.error)
            : "Execution request failed",
        );
      const next = executionViewSchema.parse(data);
      setView(next);
      const url = new URL(location.href);
      url.searchParams.set("run", next.id);
      history.replaceState(null, "", url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (new URL(location.href).searchParams.has("run")) void request();
  }, []);
  const state = view?.inspection;
  const parked = view?.status === "parked";
  return (
    <div className="execution-inspector">
      <header className="execution-heading">
        <div>
          <p className="execution-eyebrow">WORKFLOW LAB / HOOT</p>
          <h1>Inside the execution.</h1>
          <p className="execution-muted">
            Follow the stack, inspect captured state, and restore into a fresh Wasm instance.
          </p>
        </div>
        <button disabled={busy} onClick={() => void request("start")}>
          {view ? "New run" : "Run confirmation"}
        </button>
      </header>
      <p className="execution-local">
        Local playground · journal retained in server memory · each park releases compute · no email
        is sent
      </p>
      {error && (
        <div role="alert" className="execution-error">
          {error}
          <button disabled={busy} onClick={() => void request()}>
            Reload state
          </button>
        </div>
      )}
      {!view ? (
        <section className="execution-empty">
          <h2>One workflow. Two languages.</h2>
          <p>
            A Scheme caller invokes a compiled developer generator. It asks for approval, then
            suspends again during cleanup.
          </p>
          <ol>
            <li>Inspect the captured caller and helper.</li>
            <li>Restore the same boundary in a fresh instance.</li>
            <li>Approve, decline, or cancel—and follow cleanup.</li>
          </ol>
        </section>
      ) : (
        <>
          <div className="execution-toolbar">
            <span className={`execution-status ${parked ? "waiting" : ""}`}>
              {busy ? "Working…" : view.status}
            </span>
            <span className="execution-muted">
              {state?.steps ?? 0} evaluator steps ·{" "}
              {((state?.snapshotBytes ?? 0) / 1024).toFixed(1)} KB state
            </span>
            <div className="execution-actions">
              <button disabled={busy || !parked} onClick={() => void request("restore")}>
                Restore in fresh instance
              </button>
              <button
                disabled={busy || !parked || !!state?.cancellationRequested}
                onClick={() => void request("cancel")}
              >
                Cancel workflow
              </button>
            </div>
          </div>
          <div className="execution-grid">
            <section className="execution-panel">
              <header>
                <h2>Call stack</h2>
                <span className="execution-muted">outer → inner</span>
              </header>
              <ol className="execution-stack">
                {state?.calls.map((name, index) => (
                  <li key={`${name}-${index}`}>
                    <span className="execution-stack-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <strong>{name}</strong>
                      <small>
                        {name === "review_draft"
                          ? "Compiled developer generator"
                          : name === "workflow"
                            ? "Scheme caller"
                            : "Evaluator call"}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              {view.pending ? (
                <div className="execution-pending">
                  <p className="execution-eyebrow">
                    {view.pending.key === "cleanup"
                      ? "CLEANUP / WAITING FOR YOU"
                      : "HOST EFFECT / WAITING FOR YOU"}
                  </p>
                  <h3>{view.pending.message}</h3>
                  <code>{state?.site}</code>
                  <div className="execution-choices">
                    {view.pending.key === "approval" ? (
                      <>
                        <button disabled={busy} onClick={() => void request("reply", "approve")}>
                          Approve
                        </button>
                        <button disabled={busy} onClick={() => void request("reply", "decline")}>
                          Decline
                        </button>
                      </>
                    ) : (
                      <button disabled={busy} onClick={() => void request("reply", "release")}>
                        Release reservation
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="execution-result">
                  <h3>Execution {view.status}</h3>
                  <pre>{pretty(view.result)}</pre>
                </div>
              )}
              <div className="execution-cleanups">
                <h3>Scope cleanup</h3>
                {state?.cleanups
                  .filter((c) => c.remaining.length || c.kind !== "registered")
                  .map((cleanup, index) => (
                    <div key={index}>
                      <span className="execution-status">{cleanup.kind}</span>
                      {cleanup.remaining.map((item, i) => (
                        <p key={i}>
                          <code>{item}</code>
                        </p>
                      ))}
                      {cleanup.completion && (
                        <p>
                          Then continue <code>{cleanup.completion}</code>
                        </p>
                      )}
                      {cleanup.scope && <small>Scope: {cleanup.scope}</small>}
                    </div>
                  ))}
                {!state?.cleanups.some((c) => c.remaining.length || c.kind !== "registered") && (
                  <p className="execution-muted">No pending cleanup.</p>
                )}
              </div>
            </section>
            <section className="execution-panel execution-state">
              <header>
                <div className="execution-tabs">
                  <button aria-pressed={tab === "state"} onClick={() => setTab("state")}>
                    Checkpoint
                  </button>
                  <button aria-pressed={tab === "source"} onClick={() => setTab("source")}>
                    Source
                  </button>
                </div>
              </header>
              {tab === "source" ? (
                <>
                  <h3>Developer generator</h3>
                  <pre>{view.developerSource}</pre>
                  <h3>Emitted Scheme + caller</h3>
                  <pre>{view.schemeSource}</pre>
                </>
              ) : (
                <>
                  <CheckpointSummary view={view} />
                  <details className="execution-internals">
                    <summary>Internals · environments and continuation frames</summary>
                    <p className="execution-muted">
                      Environment {state?.currentEnvironment} is current. Closures reference shared
                      environment IDs.
                    </p>
                    {state?.environments.map((env) => (
                      <details
                        key={env.id}
                        open={env.id === state.currentEnvironment || env.id === 0}
                      >
                        <summary>
                          Environment {env.id}{" "}
                          <span className="execution-muted">
                            {env.parent === null ? "· root" : `→ ${env.parent}`}
                          </span>
                        </summary>
                        <dl>
                          {env.bindings.map((binding) => (
                            <div key={binding.name}>
                              <dt>{binding.name}</dt>
                              <dd>
                                <code>{binding.value}</code>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ))}
                    <details>
                      <summary>Continuation frames ({state?.frames.length ?? 0})</summary>
                      <p className="execution-muted">Top of the continuation first.</p>
                      {state?.frames.map((frame) => (
                        <pre key={frame.index}>{frame.detail}</pre>
                      ))}
                    </details>
                  </details>
                </>
              )}
            </section>
          </div>
          <section className="execution-panel execution-timeline">
            <header>
              <h2>Boundary timeline</h2>
              <span className="execution-muted">Latest first · bounded to 100 events</span>
            </header>
            {[...view.trace].reverse().map((event) => (
              <details key={event.sequence}>
                <summary>
                  <span className="execution-event-index">{event.sequence}</span>
                  <strong>{event.kind}</strong>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                  {event.durationMs !== undefined && <span>{event.durationMs.toFixed(1)} ms</span>}
                </summary>
                {event.data !== undefined && <pre>{pretty(event.data)}</pre>}
              </details>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
