import { useCallback, useEffect, useMemo, useState } from "react";
import "./styles.css";

type Row = Record<string, unknown>;

type TableReport = { rows: number; encodedBytes: number };

type StorageReport = {
  tables: Record<string, TableReport>;
  journalByTask: Array<{ executionId: string; taskId: string; rows: number; encodedBytes: number }>;
  replayByTask: Array<{ executionId: string; taskId: string; rows: number; encodedBytes: number }>;
  checkpointWriteBytes: number;
  runtimeMetricsCaptured: boolean;
  hydrationReads: number;
  hydrationReadBytes: number;
  archivePageReads: number;
  publicHistoryIndexRows: number;
  publicHistorySegmentReads: number;
  publicHistorySegmentReadBytes: number;
  peakPublicHistoryPageBytes: number;
  preparedContextReads: number;
  preparedContextReadBytes: number;
  preparedContextObjectBytes: number;
  totalRetainedArchiveBytes: number;
  totalRetainedReplayBytes: number;
  peakMaterializedReplayBytes: number;
};

type Summary = {
  databasePath: string;
  journalMode: unknown;
  report: StorageReport;
  heads: Row[];
  executions: Row[];
};

type ConversationDetail = {
  conversationId: string;
  head: Row | null;
  checkpoints: Row[];
  publicSegments: Row[];
  publicRootIndex: Row[];
  terminalSegments: Row[];
  commandReceipts: Row[];
};

type ExecutionDetail = {
  executionId: string;
  control: Row[];
  journal: Row[];
  replay: Row[];
  objects: Row[];
};

type View = "overview" | "conversation" | "execution";

const numberFormat = new Intl.NumberFormat("en-US");

function formatBytes(value: unknown): string {
  const bytes = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1_024) {
    return `${numberFormat.format(bytes)} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(2)} MiB`;
}

function shortId(value: unknown, length = 12): string {
  const text = String(value ?? "—");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function field(row: Row | null | undefined, name: string): unknown {
  return row?.[name];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return body;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SegmentTable({
  rows,
  kind,
}: {
  rows: Row[];
  kind: "public" | "terminal" | "journal" | "replay";
}) {
  if (rows.length === 0) {
    return <div className="empty">No {kind} segments.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Segment</th>
            <th>Previous</th>
            <th>Scope / range</th>
            <th>Bytes</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${String(row.segment_id)}-${index}`}>
              <td className="mono" title={String(row.segment_id)}>
                {shortId(row.segment_id, 16)}
              </td>
              <td className="mono" title={String(row.previous_segment_id ?? "")}>
                {shortId(row.previous_segment_id ?? "—", 16)}
              </td>
              <td className="mono">
                {kind === "public"
                  ? `${row.min_position} → ${row.max_position}`
                  : kind === "terminal"
                    ? `${row.first_position} → ${row.last_position}`
                    : `${row.task_id ?? "—"} · ${row.first_sequence} → ${row.last_sequence}`}
              </td>
              <td>{formatBytes(row.encoded_bytes)}</td>
              <td className="mono" title={String(row.content_hash)}>
                {shortId(row.content_hash, 16)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({
  summary,
  onSelectConversation,
  onSelectExecution,
}: {
  summary: Summary;
  onSelectConversation: (id: string) => void;
  onSelectExecution: (id: string) => void;
}) {
  const report = summary.report;
  const totalRows = Object.values(report.tables).reduce((sum, table) => sum + table.rows, 0);
  const totalBytes = Object.values(report.tables).reduce(
    (sum, table) => sum + table.encodedBytes,
    0,
  );
  return (
    <div className="content-grid">
      <Section title="Storage overview" subtitle={summary.databasePath}>
        <div className="metrics-grid">
          <Metric
            label="Journal mode"
            value={String((summary.journalMode as Row)?.journal_mode ?? "unknown")}
            detail="WAL is selected by the local composition"
          />
          <Metric
            label="Persisted rows"
            value={numberFormat.format(totalRows)}
            detail={formatBytes(totalBytes)}
          />
          <Metric
            label="Hydration reads"
            value={report.runtimeMetricsCaptured ? numberFormat.format(report.hydrationReads) : "—"}
            detail={
              report.runtimeMetricsCaptured
                ? `${formatBytes(report.hydrationReadBytes)} checkpoint payload`
                : "not captured by the read-only inspector"
            }
          />
          <Metric
            label="History page I/O"
            value={
              report.runtimeMetricsCaptured ? `${report.publicHistoryIndexRows} index row(s)` : "—"
            }
            detail={
              report.runtimeMetricsCaptured
                ? `${report.publicHistorySegmentReads} segment read(s), ${formatBytes(report.publicHistorySegmentReadBytes)}`
                : "run the storage-spine verifier for read evidence"
            }
          />
          <Metric
            label="History page memory"
            value={
              report.runtimeMetricsCaptured ? formatBytes(report.peakPublicHistoryPageBytes) : "—"
            }
            detail={`${formatBytes(report.totalRetainedArchiveBytes)} retained archive`}
          />
          <Metric
            label="Prepared context"
            value={
              report.runtimeMetricsCaptured ? formatBytes(report.preparedContextReadBytes) : "—"
            }
            detail={
              report.runtimeMetricsCaptured
                ? `${report.preparedContextReads} read(s), ${formatBytes(report.preparedContextObjectBytes)} retained`
                : `${formatBytes(report.preparedContextObjectBytes)} retained object bytes`
            }
          />
          <Metric
            label="Replay memory"
            value={formatBytes(report.peakMaterializedReplayBytes)}
            detail={`${formatBytes(report.totalRetainedReplayBytes)} retained`}
          />
        </div>
      </Section>

      <Section title="Physical tables" subtitle="What the SQLite file contains">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Rows</th>
                <th>Encoded bytes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.tables).map(([name, value]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td>{numberFormat.format(value.rows)}</td>
                  <td>{formatBytes(value.encodedBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Conversation heads" subtitle="The mutable public authority row">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Conversation</th>
                <th>State</th>
                <th>Revision</th>
                <th>Owner epoch</th>
                <th>Checkpoint</th>
                <th>Terminal history</th>
              </tr>
            </thead>
            <tbody>
              {summary.heads.map((head) => (
                <tr
                  key={String(head.conversation_id)}
                  className="clickable"
                  onClick={() => onSelectConversation(String(head.conversation_id))}
                >
                  <td className="mono">{shortId(head.conversation_id, 20)}</td>
                  <td>
                    <span className={`status status-${String(head.state)}`}>
                      {String(head.state)}
                    </span>
                  </td>
                  <td>{String(head.revision)}</td>
                  <td>{String(head.owner_epoch)}</td>
                  <td className="mono">{shortId(head.checkpoint_id, 14)}</td>
                  <td className="mono">{shortId(head.terminal_segment_id, 14)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Execution controls"
        subtitle="Private control is separate from conversation authority"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Execution</th>
                <th>Status</th>
                <th>Revision</th>
                <th>Owner fence</th>
                <th>Root task</th>
                <th>Requested disposition</th>
              </tr>
            </thead>
            <tbody>
              {summary.executions.map((execution) => (
                <tr
                  key={String(execution.execution_id)}
                  className="clickable"
                  onClick={() => onSelectExecution(String(execution.execution_id))}
                >
                  <td className="mono">{shortId(execution.execution_id, 26)}</td>
                  <td>
                    <span className={`status status-${String(execution.status)}`}>
                      {String(execution.status)}
                    </span>
                  </td>
                  <td>{String(execution.control_revision)}</td>
                  <td>{String(execution.owner_fence)}</td>
                  <td className="mono">{shortId(execution.root_task_id, 18)}</td>
                  <td>{String(execution.requested_disposition ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function ConversationView({ detail }: { detail: ConversationDetail }) {
  const head = detail.head;
  return (
    <div className="content-grid">
      <Section title="Conversation head" subtitle={detail.conversationId}>
        <div className="head-grid">
          {[
            ["State", field(head, "state")],
            ["Revision", field(head, "revision")],
            ["Owner epoch", field(head, "owner_epoch")],
            ["Active execution", field(head, "active_execution_id")],
            ["Latest completed", field(head, "latest_completed_execution_id")],
            ["Checkpoint", field(head, "checkpoint_id")],
            ["Terminal history", field(head, "terminal_segment_id")],
          ].map(([label, value]) => (
            <div className="head-field" key={String(label)}>
              <span>{String(label)}</span>
              <strong
                className={
                  String(label).includes("execution") ||
                  String(label).includes("Checkpoint") ||
                  String(label).includes("history")
                    ? "mono"
                    : ""
                }
              >
                {String(value ?? "—")}
              </strong>
            </div>
          ))}
        </div>
        <div className="muted">
          Owner routes and mutable command bodies are withheld by the inspector.
        </div>
      </Section>
      <Section
        title="Checkpoint chain"
        subtitle={`${detail.checkpoints.length} immutable checkpoint(s)`}
      >
        <div className="timeline">
          {detail.checkpoints.map((checkpoint, index) => (
            <div className="timeline-item" key={String(checkpoint.checkpoint_id)}>
              <div className="timeline-dot">{index + 1}</div>
              <div className="timeline-body">
                <div className="timeline-title">
                  <span className="mono">{shortId(checkpoint.checkpoint_id, 20)}</span>
                  <span>{formatBytes(checkpoint.encoded_bytes)}</span>
                </div>
                <div className="muted">
                  cause {shortId(checkpoint.cause_key, 22)} · archive frontier{" "}
                  {String(checkpoint.archive_frontier_ordinal)} · next position{" "}
                  {String(checkpoint.next_public_position)} · body withheld
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Public archive" subtitle="Immutable root metadata; root bodies withheld">
        <SegmentTable rows={detail.publicSegments} kind="public" />
      </Section>
      <Section
        title="Accepted root index"
        subtitle="Position membership and archive locations; bodies withheld"
      >
        {detail.publicRootIndex.length === 0 ? (
          <div className="empty">No accepted public root-index rows.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Root</th>
                  <th>Segment</th>
                  <th>Archive ordinal</th>
                  <th>Bytes</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {detail.publicRootIndex.map((row, index) => (
                  <tr key={`${String(row.root_id)}-${index}`}>
                    <td className="mono">{String(row.position)}</td>
                    <td className="mono">{shortId(row.root_id, 18)}</td>
                    <td className="mono">{shortId(row.segment_id, 18)}</td>
                    <td className="mono">{String(row.archive_ordinal)}</td>
                    <td>{formatBytes(row.encoded_bytes)}</td>
                    <td className="mono">{shortId(row.content_hash, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section
        title="Terminal history"
        subtitle="One chat_turn publication per logical execution; entries withheld"
      >
        <SegmentTable rows={detail.terminalSegments} kind="terminal" />
      </Section>
      <Section
        title="Command receipts"
        subtitle="Admission evidence, independent of response-tail sessions"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Command</th>
                <th>Participant</th>
                <th>Admitted revision</th>
                <th>Resulting revision</th>
                <th>Turn / execution</th>
              </tr>
            </thead>
            <tbody>
              {detail.commandReceipts.map((receipt) => (
                <tr key={String(receipt.command_id)}>
                  <td className="mono">{shortId(receipt.command_id, 20)}</td>
                  <td>{String(receipt.participant_id)}</td>
                  <td>{String(receipt.admitted_revision)}</td>
                  <td>{String(receipt.resulting_revision)}</td>
                  <td className="mono">{shortId(receipt.execution_id, 24)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function ExecutionView({ detail }: { detail: ExecutionDetail }) {
  return (
    <div className="content-grid">
      <Section title="Execution control" subtitle={`${detail.executionId} · control body withheld`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Execution</th>
                <th>Status</th>
                <th>Revision</th>
                <th>Owner fence</th>
                <th>Root task</th>
                <th>Disposition</th>
              </tr>
            </thead>
            <tbody>
              {detail.control.map((control) => (
                <tr key={String(control.execution_id)}>
                  <td className="mono">{shortId(control.execution_id, 24)}</td>
                  <td>{String(control.status)}</td>
                  <td>{String(control.control_revision)}</td>
                  <td>{String(control.owner_fence)}</td>
                  <td className="mono">{shortId(control.root_task_id, 20)}</td>
                  <td>{String(control.requested_disposition ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section
        title="Journal segments"
        subtitle={`${detail.journal.length} immutable task-local segment(s); entries withheld`}
      >
        <SegmentTable rows={detail.journal} kind="journal" />
      </Section>
      <Section
        title="Replay segments"
        subtitle={`${detail.replay.length} immutable task-local segment(s); entries withheld`}
      >
        <SegmentTable rows={detail.replay} kind="replay" />
      </Section>
      <Section
        title="Execution objects"
        subtitle="Immutable body metadata with explicit lifetime scope; bodies withheld"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Object</th>
                <th>Scope</th>
                <th>Owner</th>
                <th>Kind</th>
                <th>Bytes</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {detail.objects.map((object) => (
                <tr key={String(object.object_id)}>
                  <td className="mono">{shortId(object.object_id, 18)}</td>
                  <td>
                    <span className="scope">{String(object.lifetime_scope)}</span>
                  </td>
                  <td className="mono">{shortId(object.scope_owner_id, 24)}</td>
                  <td>{String(object.object_kind)}</td>
                  <td>{formatBytes(object.byte_length)}</td>
                  <td className="mono">{shortId(object.content_hash, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

export function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getJson<Summary>("/api/storage/summary");
      setSummary(next);
      setError(null);
      setLastUpdated(new Date());
      if (conversation) {
        setConversation(
          await getJson<ConversationDetail>(
            `/api/storage/conversations/${encodeURIComponent(conversation.conversationId)}`,
          ),
        );
      }
      if (execution) {
        setExecution(
          await getJson<ExecutionDetail>(
            `/api/storage/executions/${encodeURIComponent(execution.executionId)}`,
          ),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [conversation, execution]);

  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectConversation = useCallback(async (id: string) => {
    try {
      setConversation(
        await getJson<ConversationDetail>(`/api/storage/conversations/${encodeURIComponent(id)}`),
      );
      setView("conversation");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const selectExecution = useCallback(async (id: string) => {
    try {
      setExecution(
        await getJson<ExecutionDetail>(`/api/storage/executions/${encodeURIComponent(id)}`),
      );
      setView("execution");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const title =
    view === "overview"
      ? "Storage overview"
      : view === "conversation"
        ? "Conversation authority"
        : "Execution authority";
  const mode = useMemo(
    () => String((summary?.journalMode as Row | undefined)?.journal_mode ?? "offline"),
    [summary],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="eyebrow">Sweatpants durability</div>
            <h1>Storage Inspector</h1>
          </div>
        </div>
        <div className="top-actions">
          <span className="connection">
            <i className={summary ? "online" : "offline"} />
            {summary ? mode : "offline"}
          </span>
          <button className="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-label">Views</div>
          <button
            className={view === "overview" ? "nav active" : "nav"}
            onClick={() => setView("overview")}
          >
            Overview <span>⌂</span>
          </button>
          <div className="sidebar-label">Conversations</div>
          {summary?.heads.map((head) => (
            <button
              key={String(head.conversation_id)}
              className={
                view === "conversation" && conversation?.conversationId === head.conversation_id
                  ? "nav active"
                  : "nav"
              }
              onClick={() => void selectConversation(String(head.conversation_id))}
            >
              <span className="nav-dot conversation-dot" />
              {shortId(head.conversation_id, 20)}
            </button>
          ))}
          <div className="sidebar-label">Executions</div>
          {summary?.executions.map((item) => (
            <button
              key={String(item.execution_id)}
              className={
                view === "execution" && execution?.executionId === item.execution_id
                  ? "nav active"
                  : "nav"
              }
              onClick={() => void selectExecution(String(item.execution_id))}
            >
              <span className="nav-dot execution-dot" />
              {shortId(item.execution_id, 20)}
            </button>
          ))}
          <div className="sidebar-footer">
            <div className="sidebar-label">Database</div>
            <div className="path" title={summary?.databasePath}>
              {summary?.databasePath ?? "No database loaded"}
            </div>
            <div className="muted">Updated {lastUpdated?.toLocaleTimeString() ?? "—"}</div>
          </div>
        </aside>
        <main className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">Read-only physical evidence</div>
              <h2>{title}</h2>
            </div>
            {summary ? <span className="fixture-badge">No mutation APIs</span> : null}
          </div>
          {error ? (
            <div className="error-banner">
              <strong>Inspector unavailable</strong>
              <span>{error}</span>
            </div>
          ) : null}
          {!error && summary && view === "overview" ? (
            <Overview
              summary={summary}
              onSelectConversation={selectConversation}
              onSelectExecution={selectExecution}
            />
          ) : null}
          {!error && conversation && view === "conversation" ? (
            <ConversationView detail={conversation} />
          ) : null}
          {!error && execution && view === "execution" ? (
            <ExecutionView detail={execution} />
          ) : null}
          {!error && !summary && !loading ? (
            <div className="empty large">
              No SQLite spine is available. Set <code>SWEATPANTS_STORAGE_SPINE_PATH</code> or
              generate the default fixture.
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
