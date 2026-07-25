import { describe, expect, it } from "vitest";
import {
  answerFor,
  createBookFlightSubstrate,
  latestToolCallId,
  post,
  postAndAbandon,
  publicInterrupt,
  reattach,
  readJournal,
  type BookFlightSubstrate,
  type PublicEvent,
} from "./fixtures/book-flight-harness.ts";
import type { DurableSemanticRecord } from "@sweatpants/session-contract";

/** Observable result of one book_flight conversation, independent of placement. */
interface BookingOutcome {
  readonly completed: boolean;
  readonly runError: boolean;
  readonly terminalRecord: string | undefined;
  readonly terminalError: string | undefined;
  readonly foreignStarts: number;
}

function summarize(journal: DurableSemanticRecord[], events: PublicEvent[]): BookingOutcome {
  const terminal = journal.at(-1)?.payload;
  const effectNames = journal.flatMap((entry) =>
    entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "effect"
      ? [entry.payload.descriptor.name]
      : [],
  );
  return {
    completed: events.some(
      (event) =>
        event.type === "TEXT_MESSAGE_CONTENT" && event["delta"] === "Your flight is booked.",
    ),
    runError: events.some((event) => event.type === "RUN_ERROR"),
    terminalRecord: terminal?.type,
    terminalError:
      terminal &&
      "outcome" in terminal &&
      terminal.outcome !== null &&
      typeof terminal.outcome === "object" &&
      "error" in terminal.outcome &&
      terminal.outcome.error !== null &&
      typeof terminal.outcome.error === "object" &&
      "code" in terminal.outcome.error &&
      typeof terminal.outcome.error.code === "string"
        ? terminal.outcome.error.code
        : undefined,
    foreignStarts: effectNames.filter((name) => name === "foreign.tool.start").length,
  };
}

/** Answers every pending elicitation on the supplied runtime until settlement. */
async function settle(
  substrate: BookFlightSubstrate,
  runtime: { handle(request: Request): Promise<Response> },
  events: PublicEvent[],
): Promise<BookingOutcome> {
  let current = events;
  let callId = latestToolCallId(current) ?? "call-http-book-flight";
  for (let round = 0; round < 8; round += 1) {
    const pending = publicInterrupt(current);
    if (!pending) {
      break;
    }
    current = await post(runtime.handle, substrate.conversationId, substrate.messages, {
      interruptId: pending.id,
      result: answerFor(pending.message),
      callId,
    });
    callId = latestToolCallId(current) ?? callId;
  }
  const journal = await readJournal(substrate.journalStore, substrate.conversationId);
  return summarize(journal, current);
}

describe("book_flight durability across host replacement", () => {
  it("completes on a single host", async () => {
    const substrate = await createBookFlightSubstrate({ conversationId: "bf-baseline" });
    const runtime = substrate.createRuntime();
    try {
      const first = await post(runtime.handle, substrate.conversationId, substrate.messages);
      const outcome = await settle(substrate, runtime, first);

      expect(outcome.completed).toBe(true);
      expect(outcome.runError).toBe(false);
      expect(outcome.terminalRecord).toBe("TaskClosed");
      expect(outcome.foreignStarts).toBe(1);
    } finally {
      await runtime.close();
      await substrate.close();
    }
  }, 30_000);

  it("survives a dropped response stream when the host stays up", async () => {
    // Control: proves the abandon/reattach harness path is sound on its own.
    const substrate = await createBookFlightSubstrate({ conversationId: "bf-dropped-stream" });
    const runtime = substrate.createRuntime();
    try {
      const abandoned = await postAndAbandon(
        runtime.handle,
        substrate.conversationId,
        substrate.messages,
        4,
      );
      expect(abandoned.aborted).toBe(true);

      const reattached = await reattach(runtime.handle, substrate.conversationId);
      const outcome = await settle(substrate, runtime, reattached);

      expect(outcome.completed).toBe(true);
      expect(outcome.runError).toBe(false);
      expect(outcome.terminalRecord).toBe("TaskClosed");
    } finally {
      await runtime.close();
      await substrate.close();
    }
  }, 30_000);

  it("survives host replacement between turns", async () => {
    // No fault injection at all. The first turn completes cleanly and parks on
    // an elicitation. The host is then replaced — a deploy, a crash, a scale-in
    // — and the user answers. All durable state is shared by the substrate, so
    // only in-process state is lost.
    //
    // The journal-native equivalent of this test (play_ttt) passes. This one
    // fails: `foreign.tool.continue` resolves against a foreign ToolSession
    // whose in-process continuation died with the old host, and the whole task
    // closes with `foreign_session_ended`.
    const substrate = await createBookFlightSubstrate({ conversationId: "bf-host-replaced" });
    let runtime = substrate.createRuntime();
    try {
      const first = await post(runtime.handle, substrate.conversationId, substrate.messages);
      expect(publicInterrupt(first), "first turn must park on an elicitation").toBeDefined();

      await runtime.close();
      runtime = substrate.createRuntime();

      const outcome = await settle(substrate, runtime, first);

      expect(
        outcome.terminalError,
        "booking must not close with a durable error after host replacement",
      ).toBeUndefined();
      expect(outcome.runError, "replacing the host must not surface a run error").toBe(false);
      expect(outcome.completed, "booking must survive host replacement").toBe(true);
      expect(
        outcome.foreignStarts,
        "the model restarts the foreign flow after the dead session is reported",
      ).toBe(2);
    } finally {
      await runtime.close();
      await substrate.close();
    }
  }, 30_000);
});
