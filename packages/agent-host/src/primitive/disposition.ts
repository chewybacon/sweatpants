import type { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";

/** The target journal owns disposition. Call settlement only after its native owner has joined. */
export function resolveTurnDisposition(
  journal: SqliteJournal,
  settlement?: { type: "interrupt" } | { type: "failure"; reason: string },
) {
  let snapshot = journal.read();
  if (settlement) {
    if (snapshot.status === "interrupting") {
      journal.settle("cancelled", snapshot.reason);
    } else if (snapshot.status === "running" && settlement.type === "failure") {
      journal.settle("failed", settlement.reason);
    }
    snapshot = journal.read();
  }
  const requests = journal.readRequests();
  const terminal = ["completed", "cancelled", "failed"].includes(snapshot.status);
  const state = terminal
    ? "idle"
    : snapshot.status === "running" && requests.some((request) => request.status === "pending")
      ? "parked"
      : "running";
  const failure =
    snapshot.status === "cancelled" || snapshot.status === "failed"
      ? {
          code: snapshot.status === "cancelled" ? "PROGRAM_CANCELLED" : "EXECUTION_FAILED",
          message: snapshot.reason,
        }
      : undefined;
  return { snapshot, requests, terminal, state, failure };
}
