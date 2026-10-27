import type { Json } from "@sweatpants/foundation";
import type {
  Guest,
  GuestWork,
  Work,
  IterableOperation,
  Turn,
  Outcome,
} from "@sweatpants/foundation/computation";
import { createGuest, success, failure } from "@sweatpants/foundation/computation";
import { createIteratorGuest } from "@sweatpants/primitive-journal";
import type { JournalRequest } from "@sweatpants/agent-sdk";

/** Private composition request: intercepted here, never journaled or sent over a wire. */
export type Invocation<Y> = {
  kind: "invoke-tool";
  work: GuestWork<Outcome<Json, Json>, JournalRequest, Y, Json, Json>;
};

/** Compose acquired child cursors without inspecting tools or selecting placement. */
export function createChatGuest<Y, Request extends { kind: string }>(
  work: Work<Json, Request | Invocation<Y>>,
): Guest<Json, Request | JournalRequest, Y, Json, Json> {
  const chat = createIteratorGuest(work);
  let child: Guest<Outcome<Json, Json>, JournalRequest, Y, Json, Json> | undefined;

  function* closeChild(): IterableOperation<void, Y> {
    const current = child;
    if (current) {
      yield* current.close();
      child = undefined;
    }
  }
  function* pump(
    turn: Turn<Json, Request | Invocation<Y>>,
  ): IterableOperation<Turn<Json, Request | JournalRequest>, Y> {
    while (true) {
      if (turn.kind === "completed") {
        return turn;
      }
      if (!isInvocation(turn.request)) {
        return { kind: "suspended", request: turn.request };
      }
      child = yield* turn.request.work();
      const next = yield* child.start();
      if (next.kind === "suspended") {
        return next;
      }
      yield* closeChild();
      turn = yield* chat.resume(toolOutcome(next.value));
    }
  }
  return createGuest({
    *start() {
      const turn = yield* chat.start();
      return yield* pump(turn);
    },
    *resume(outcome: Outcome<Json, Json>) {
      if (child) {
        const next = yield* child.resume(outcome);
        if (next.kind === "suspended") {
          return next;
        }
        yield* closeChild();
        const turn = yield* chat.resume(toolOutcome(next.value));
        return yield* pump(turn);
      }
      const turn = yield* chat.resume(outcome);
      return yield* pump(turn);
    },
    *close() {
      try {
        yield* closeChild();
      } finally {
        yield* chat.close();
      }
    },
  });
}

function isInvocation<Y, Request extends { kind: string }>(
  request: Request | Invocation<Y>,
): request is Invocation<Y> {
  return request.kind === "invoke-tool";
}

function toolOutcome(outcome: Outcome<Json, Json>): Outcome<Json, unknown> {
  return outcome.ok ? success(outcome.value) : failure(new Error(String(outcome.error)));
}
