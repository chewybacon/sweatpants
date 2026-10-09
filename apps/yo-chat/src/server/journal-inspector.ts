import { run } from "effection";
import type { ProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";

export type ProgramJournalInspection = {
  conversationId: string;
  recordCount: number;
  summary: {
    taskCount: number;
    pendingPullIds: string[];
    recordsByType: Record<string, number>;
  };
  records: Array<Record<string, unknown>>;
};

/** Resolves the journal store owned by the running yo-chat application. */
async function activeJournalStore(): Promise<ProgramDriverJournalStore> {
  try {
    const { chatApp } = await import("./chat-application");
    return (await chatApp.inspect()).programDriverJournalStore;
  } catch (error) {
    console.error("[journal-inspector] chat application storage is unavailable", { error });
    throw new JournalInspectorError("journal_store_unavailable", 503);
  }
}

/** Reads and safely redacts one ProgramDriver semantic journal. */
export async function inspectProgramDriverJournal(
  conversationId: string,
  store?: ProgramDriverJournalStore,
): Promise<ProgramJournalInspection> {
  const journalStore = store ?? (await activeJournalStore());
  const records = await run(function* () {
    return yield* journalStore.withJournal(conversationId, (journal) =>
      journal.readJournal(conversationId),
    );
  });
  const redacted = records.map((record) => redactSensitive(record));
  return {
    conversationId,
    recordCount: redacted.length,
    summary: summarize(redacted),
    records: redacted,
  };
}

export class JournalInspectorError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "JournalInspectorError";
  }
}

function summarize(records: Array<Record<string, unknown>>) {
  const byType: Record<string, number> = {};
  const taskIds = new Set<string>();
  const pendingPulls = new Set<string>();
  for (const record of records) {
    const payload = asRecord(record["payload"]);
    const type = typeof payload?.["type"] === "string" ? payload["type"] : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (typeof payload?.["taskId"] === "string") {
      taskIds.add(payload["taskId"]);
    }
    if (type === "PullRequested" && typeof payload?.["pullId"] === "string") {
      pendingPulls.add(payload["pullId"]);
    }
    if (type === "PullResolved" && typeof payload?.["pullId"] === "string") {
      pendingPulls.delete(payload["pullId"]);
    }
  }
  return {
    taskCount: taskIds.size,
    pendingPullIds: [...pendingPulls],
    recordsByType: byType,
  };
}

function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = /capability|authorization|credential|secret|token/i.test(key)
      ? "[redacted]"
      : redactSensitive(child);
  }
  return output as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
