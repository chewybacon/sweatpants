import { uuidv7 } from "@sweatpants/foundation";
import type { AuthorityState } from "../contract/authority-contract.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";

/** Stage identities with the append: only the winning state commit publishes them. */
export function advanceJournalHeadIdentities(
  state: AuthorityState,
  entries: readonly DurableSemanticRecord[],
  proposedHeads: Map<string, string> = new Map(),
): AuthorityState {
  if (entries.length === 0) {
    return state;
  }
  const sessions = new Map(state.sessions);
  for (const sessionId of new Set(entries.map((entry) => entry.sessionId))) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Journal append names unknown session ${sessionId}`);
    }
    const journalHeadId = proposedHeads.get(sessionId) ?? uuidv7();
    proposedHeads.set(sessionId, journalHeadId);
    sessions.set(sessionId, {
      ...session,
      control: { ...session.control, journalHeadId },
    });
  }
  return { ...state, sessions };
}
