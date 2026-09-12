import { scoped, type Operation } from "effection";
import { installConversationStore } from "@sweatpants/history-store/port";
import type { ConversationStore } from "@sweatpants/history-store/contract";

/**
 * Test-only. Port drivers are terminal per scope, so a test that must route
 * calls through a specific store instance (an observed wrapper, a corrupted
 * stub) installs that store as the driver in a child scope. Application code
 * installs one driver at entry and never swaps it.
 */
export function withConversationStore<T>(
  store: ConversationStore,
  op: () => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    yield* installConversationStore(store);
    return yield* op();
  });
}
