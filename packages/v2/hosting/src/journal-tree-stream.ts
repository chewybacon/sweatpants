import type { JournalReader } from "@sweatpan.ts/durable";
import { createPullStream, type PullStreamScope, type Stream } from "@sweatpan.ts/runtime";
import type { JournalTreeObservation } from "./contracts.ts";
import { projectJournalState } from "./presentation-state.ts";

/** Pull-only, depth-first preorder over active ownership links captured at each read.
 * One subscription belongs to owner; early owner exit releases traversal state.
 * Each pull reads one node, opening its persisted direct-child link when needed.
 * No history pages, Guest acquisition, result bindings or journal writes are involved.
 *
 * Observations have separate revisions. Completion means captured paths were visited,
 * not that they were simultaneously current. A growing tree need not finish in bounded
 * time. Read/open errors fail the stream; prior observations remain partial. Callers
 * own connection lifetime and must create a fresh stream/reader after reopening.
 */
export function createJournalTreeStream<Y>(
  owner: PullStreamScope<Y>,
  root: JournalReader<unknown, unknown, unknown, unknown, unknown, Y>,
): Stream<JournalTreeObservation, void, Y> {
  type Reader = JournalReader<unknown, unknown, unknown, unknown, unknown, Y>;
  type Visit =
    | { readonly reader: Reader }
    | { readonly owner: Reader; readonly child: string; readonly requestId: string };
  return createPullStream<JournalTreeObservation, void, Y, Y>(owner, () => {
    const remaining: Visit[] = [{ reader: root }];
    return function* () {
      const visit = remaining.pop();
      if (!visit) {
        return { done: true, value: undefined };
      }
      const reader = "reader" in visit ? visit.reader : yield* visit.owner.openChild(visit.child);
      const snapshot = yield* reader.read();
      if (snapshot.status === "running") {
        // Capture only routing identities before exposing the detached observation.
        // Mutation of an emitted children array cannot redirect future traversal.
        for (const link of [...(snapshot.children ?? [])].reverse()) {
          remaining.push({ owner: reader, child: link.childId, requestId: link.requestId });
        }
      }
      return {
        done: false,
        value: {
          execution: reader.id,
          program: snapshot.program,
          parent:
            "reader" in visit
              ? undefined
              : { execution: visit.owner.id, requestId: visit.requestId },
          state: projectJournalState(snapshot),
        },
      };
    };
  });
}
