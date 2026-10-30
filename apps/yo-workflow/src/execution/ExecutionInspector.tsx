import { useEffect, useState } from "react";
import { displayInspectedValue } from "./inspection.ts";
import { CheckpointSummary } from "./CheckpointSummary.tsx";
import {
  executionViewSchema,
  languageCatalogSchema,
  type WorkflowLanguage,
  type ExecutionView,
} from "./contract.ts";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export function ExecutionInspector() {
  const [languages, setLanguages] = useState<WorkflowLanguage[]>([]);
  const [language, setLanguage] = useState("scheme");
  const [pythonExample, setPythonExample] = useState("reads");
  const [view, setView] = useState<ExecutionView | null>(null);
  const [prompt, setPrompt] = useState(
    "Review the launch announcement, and if I approve it, send it to Sam.",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authoringError, setAuthoringError] = useState(false);
  const [tab, setTab] = useState<"state" | "source">("state");
  async function request(action?: string, choice?: string, author = false, operationId?: number) {
    setBusy(true);
    setError(null);
    setAuthoringError(false);
    try {
      const id = view?.id ?? new URL(location.href).searchParams.get("run");
      const response = await fetch(
        action ? "/api/execution" : `/api/execution?id=${encodeURIComponent(id ?? "")}`,
        action
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action,
                choice,
                operationId,
                id: action === "start" ? undefined : id,
                language: action === "start" ? language : view?.language.id,
                revision: view?.revision,
                /* CONDITIONAL-SPREAD: Omit absent prompt from workflow requests and execution events; explicit undefined is not a portable JSON value. */
                ...(author ? { prompt } : {}),
                /* CONDITIONAL-SPREAD: Omit the example on non-Python starts and resume commands. */
                ...(action === "start" && language === "monty" && pythonExample !== "reads"
                  ? { example: pythonExample }
                  : {}),
              }),
            }
          : undefined,
      );
      const data: unknown = await response.json();
      if (!response.ok) {
        throw Error(
          typeof data === "object" && data && "error" in data
            ? String(data.error)
            : "Execution request failed",
        );
      }
      const next = executionViewSchema.parse(data);
      setView(next);
      setLanguage(next.language.id);
      const url = new URL(location.href);
      url.searchParams.set("run", next.id);
      history.replaceState(null, "", url);
    } catch (cause) {
      setAuthoringError(author);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void fetch("/api/execution")
      .then(async (response) => {
        if (!response.ok) {
          throw Error("Unable to load workflow languages");
        }
        const catalog = languageCatalogSchema.parse(await response.json());
        setLanguages(catalog.languages);
      })
      .catch((cause) => setError(String(cause)));
  }, []);
  useEffect(() => {
    if (new URL(location.href).searchParams.has("run")) {
      void request();
    }
  }, []);
  const state = view?.inspection;
  const execution = state?.execution;
  const parked = view?.status === "parked";
  return (
    <div className="execution-inspector">
      <header className="execution-heading">
        <div>
          <p className="execution-eyebrow">WORKFLOW LAB</p>
          <h1>Inside the execution.</h1>
          <p className="execution-muted">
            Explore Scheme and Lua tools, or a Python workflow with five concurrent file reads.
            Restore a saved execution in a fresh instance.
          </p>
        </div>
        <label className="execution-language">
          Caller language for new run
          <select
            value={language}
            disabled={busy || !languages.length}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {languages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.runtime}
              </option>
            ))}
          </select>
        </label>
        {language === "monty" && (
          <label className="execution-language">
            Python example
            <select
              value={pythonExample}
              disabled={busy}
              onChange={(event) => setPythonExample(event.target.value)}
            >
              <option value="reads">asyncio · five reads</option>
              <option value="cleanup">asyncio · yielding cleanup</option>
              <option value="anyio">AnyIO · shielded cleanup</option>
            </select>
          </label>
        )}
        <button disabled={busy || !languages.length} onClick={() => void request("start")}>
          {language === "monty"
            ? pythonExample === "reads"
              ? "Run five reads"
              : "Run Python cleanup"
            : view
              ? "New confirmation run"
              : "Run confirmation"}
        </button>
      </header>
      <p className="execution-local">
        Workflow lab · journal-backed execution · each park releases compute · no email is sent
      </p>
      {language !== "monty" && (
        <section className="execution-author">
          <label htmlFor="caller-prompt">Model-authored caller</label>
          <textarea
            id="caller-prompt"
            value={prompt}
            maxLength={4000}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy}
          />
          <button
            disabled={busy || !languages.length || !prompt.trim()}
            onClick={() => void request("start", undefined, true)}
          >
            {busy ? "Working…" : "Author and run"}
          </button>
          <p className="execution-muted">
            The model writes the caller in your selected language. Both runtimes run the same
            TypeScript review_draft tool, including its ensure cleanup, then call the uncompiled
            host tool.
          </p>
        </section>
      )}
      {language !== "monty" && (
        <div className="execution-tool-catalog">
          <div>
            <span className="execution-status">Compiled workflow</span>
            <h3>review_draft</h3>
            <p>
              One TypeScript generator, compiled for each runtime. Its ensure cleanup can suspend.
            </p>
          </div>
          <div>
            <span className="execution-status waiting">Host tool</span>
            <h3>send_announcement</h3>
            <p>
              Queues a local announcement. Only its request and recorded receipt enter the workflow.
            </p>
          </div>
        </div>
      )}
      {language === "monty" && (
        <p className="execution-local">
          Five reads run together. Fulfill them in any order from the local fixtures, or restore
          between replies. This demo is authored in Python; compiled TypeScript tools and model
          authoring are not yet supported.
        </p>
      )}
      {error && (
        <div role="alert" className="execution-error">
          {error}
          <button
            disabled={busy}
            onClick={() => {
              if (!languages.length) {
                location.reload();
                return;
              }
              void (authoringError ? request("start", undefined, true) : request());
            }}
          >
            {authoringError ? "Retry authoring" : "Reload state"}
          </button>
        </div>
      )}
      {!view ? (
        <section className="execution-empty">
          <h2>
            {language === "monty" ? "Five reads, one workflow." : "One program. Two kinds of tool."}
          </h2>
          <p>
            {language === "monty"
              ? "Fulfill reads in any order from bounded local fixtures. Results retain input order."
              : "Review a draft, finish its cleanup, then queue the approved announcement through the host."}
          </p>
          <ol>
            <li>
              {language === "monty"
                ? "Read the Python workflow source."
                : "Inspect the captured caller and helper."}
            </li>
            <li>Restore the same boundary in a fresh instance.</li>
            <li>
              {language === "monty"
                ? "Fulfill reads in any order or cancel the workflow."
                : "Approve, decline, or cancel—and follow cleanup."}
            </li>
          </ol>
        </section>
      ) : (
        <>
          <div className="execution-toolbar">
            <span className={`execution-status ${parked ? "waiting" : ""}`}>
              {busy ? "Working…" : view.status}
            </span>
            <span className="execution-muted">
              {view.language.label} · {view.language.runtime} ·{" "}
              {state?.steps != null ? `${state.steps} evaluator steps · ` : ""}
              {((state?.snapshotBytes ?? 0) / 1024).toFixed(1)} KB state
            </span>
            <div className="execution-actions">
              <button disabled={busy || !parked} onClick={() => void request("restore")}>
                Restore in fresh instance
              </button>
              <button
                disabled={
                  busy ||
                  !parked ||
                  (view.language.id !== "monty" && !!state?.cancellationRequested)
                }
                onClick={() => void request("cancel")}
              >
                Cancel workflow
              </button>
            </div>
          </div>
          <div className="execution-grid">
            <section className="execution-panel">
              <header>
                <h2>{view.language.id === "monty" ? "Outstanding operations" : "Call stack"}</h2>
                {view.language.id !== "monty" && (
                  <span className="execution-muted">outer → inner</span>
                )}
              </header>
              {view.language.id === "monty" && (
                <p className="execution-muted">
                  Python frames and local variables are not decoded. The operations below are
                  requests received by the host.
                </p>
              )}
              <ol className="execution-stack">
                {execution?.calls.map(({ id, name }, index) => (
                  <li key={id}>
                    <span className="execution-stack-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <strong>{name}</strong>
                      <small>
                        {name === "review_draft"
                          ? "Compiled developer generator"
                          : name === "workflow"
                            ? `${view.language.label} caller`
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
                  {view.language.id !== "monty" && <code>{state?.site}</code>}
                  <div className="execution-choices">
                    {view.language.id === "monty" ? (
                      view.operations.map((op) => (
                        <button
                          key={op.id}
                          disabled={busy}
                          onClick={() => void request("reply", "fixture", false, op.id)}
                        >
                          {op.label}
                        </button>
                      ))
                    ) : view.pending.key === "approval" ? (
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
                {execution?.unwind.map((entry, index) => {
                  const pending =
                    entry.kind === "scope"
                      ? entry.pendingCleanup
                      : entry.kind === "cleanup"
                        ? entry.remaining
                        : [];
                  if (entry.kind === "scope" && !pending.length) {
                    return null;
                  }
                  return (
                    <div key={index}>
                      <span className="execution-status">{entry.kind}</span>
                      {pending.map((item, i) => (
                        <p key={i}>
                          <code>{displayInspectedValue(item)}</code>
                        </p>
                      ))}
                      {entry.kind !== "scope" && (
                        <p>
                          Then continue{" "}
                          <code>
                            {entry.completion.kind}
                            {"value" in entry.completion
                              ? `: ${displayInspectedValue(entry.completion.value)}`
                              : ""}
                          </code>
                        </p>
                      )}
                      {entry.kind === "scope" && <small>Scope: {entry.label}</small>}
                    </div>
                  );
                })}
                {!execution?.unwind.some(
                  (entry) => entry.kind !== "scope" || entry.pendingCleanup.length,
                ) && (
                  <p className="execution-muted">
                    {execution?.availability.unwind === "unavailable"
                      ? "Cleanup inspection is unavailable for this runtime."
                      : "No pending cleanup."}
                  </p>
                )}
                {execution?.truncated && (
                  <p className="execution-muted">Inspection shortened to its display limits.</p>
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
                  <h3>Developer workflow · {view.language.developerLanguage}</h3>
                  <pre>{view.developerSource}</pre>
                  {view.language.id !== "monty" && (
                    <>
                      <h3>Linked {view.language.label} program</h3>
                      <pre>{view.programSource}</pre>
                    </>
                  )}
                </>
              ) : (
                <>
                  <CheckpointSummary view={view} />
                  {view.language.id !== "monty" && (
                    <details className="execution-internals">
                      <summary>Internals · environments and continuation frames</summary>
                      <p className="execution-muted">
                        {state?.currentEnvironment == null
                          ? "Lua frame/register data is available below and in the checkpoint. Lexical environment names are not projected."
                          : `Environment ${state.currentEnvironment} is current. Closures reference shared environment IDs.`}
                      </p>
                      {execution?.environments.map((env) => (
                        <details
                          key={env.id}
                          open={env.id === String(state?.currentEnvironment) || env.id === "0"}
                        >
                          <summary>
                            Environment {env.id}{" "}
                            <span className="execution-muted">
                              {env.parentId === null ? "· root" : `→ ${env.parentId}`}
                            </span>
                          </summary>
                          <dl>
                            {env.bindings.map((binding) => (
                              <div key={binding.name}>
                                <dt>{binding.name}</dt>
                                <dd>
                                  <code>{displayInspectedValue(binding.value)}</code>
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
                  )}
                </>
              )}
            </section>
          </div>
          {view.language.id !== "monty" && (
            <section className="execution-panel execution-timeline">
              <header>
                <h2>Announcement outbox</h2>
                <span className="execution-muted">Host tool · local only</span>
              </header>
              <p className="execution-muted">
                Approved path: review → tool cleanup → send_announcement → recorded receipt
              </p>
              {view.outbox.length === 0 ? (
                <p>No announcements queued.</p>
              ) : (
                view.outbox.map((item) => (
                  <div className="execution-pending" key={item.announcementId}>
                    <span className="execution-status">{item.status}</span>
                    <h3>{item.title}</h3>
                    <p>To: {item.recipient}</p>
                    <code>{item.announcementId}</code>
                  </div>
                ))
              )}
            </section>
          )}
          <section className="execution-panel execution-timeline">
            <header>
              <h2>Boundary timeline</h2>
              <span className="execution-muted">Latest first · bounded to 100 events</span>
            </header>
            {/* oxlint-disable-next-line unicorn/no-array-reverse -- App targets ES2022; reverse an owned copy. */}
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
