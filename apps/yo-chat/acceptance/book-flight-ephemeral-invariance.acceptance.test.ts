import { describe, expect, it } from "vitest";
import {
  answerFor,
  createBookFlightSubstrate,
  latestToolCallId,
  post,
  postAndDisconnect,
  publicInterrupt,
  reattach,
  readJournal,
  type BookFlightSubstrate,
  type PublicEvent,
} from "./fixtures/book-flight-harness.ts";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";

/** Observable result of one book_flight conversation, independent of placement. */
interface BookingOutcome {
  readonly completed: boolean;
  readonly runError: boolean;
  readonly terminalRecord: string | undefined;
  readonly terminalError: string | undefined;
  readonly ephemeralStarts: number;
}

function summarize(journal: DurableSemanticRecord[], events: PublicEvent[]): BookingOutcome {
  const terminal = [...journal]
    .reverse()
    .find(
      (entry) => entry.payload.type === "TaskClosed" || entry.payload.type === "TaskOrphaned",
    )?.payload;
  const effectNames = journal.flatMap((entry) =>
    entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "effect"
      ? [entry.payload.descriptor.name]
      : [],
  );
  return {
    completed: events.some(
      (event) =>
        (event.type === "TEXT_MESSAGE_CONTENT" && event["delta"] === "Your flight is booked.") ||
        JSON.stringify(event).includes("Your flight is booked."),
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
    ephemeralStarts: effectNames.filter((name) => name === "ephemeral.tool.start").length,
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
      commandId: crypto.randomUUID(),
      interruptId: pending.id,
      result: answerFor(pending.message),
      basisRevision: pending.basisRevision,
      logicalTurnId: pending.logicalTurnId,
      executionId: pending.executionId,
      callId,
      ...(pending.parentRunId ? { parentRunId: pending.parentRunId } : {}),
    });
    callId = latestToolCallId(current) ?? callId;
  }
  const journal = await readJournal(substrate.journalStore, substrate.conversationId);
  return summarize(journal, current);
}

describe("book_flight durability across disconnect and runtime replacement", () => {
  it("completes on a single host", async () => {
    const substrate = await createBookFlightSubstrate({ conversationId: "bf-baseline" });
    const runtime = substrate.createRuntime();
    try {
      const first = await post(runtime.handle, substrate.conversationId, substrate.messages);
      const outcome = await settle(substrate, runtime, first);

      expect(outcome.completed).toBe(true);
      expect(outcome.runError).toBe(false);
      expect(outcome.terminalRecord).toBe("TaskClosed");
      expect(outcome.ephemeralStarts).toBe(1);
    } finally {
      await runtime.close();
      await substrate.close();
    }
  }, 30_000);

  it("survives a dropped response stream when the host stays up", async () => {
    // Control: proves the disconnect/reattach path is sound on its own.
    const substrate = await createBookFlightSubstrate({ conversationId: "bf-dropped-stream" });
    const runtime = substrate.createRuntime();
    try {
      const disconnected = await postAndDisconnect(
        runtime.handle,
        substrate.conversationId,
        substrate.messages,
        4,
      );
      expect(disconnected.aborted).toBe(true);

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

  it("survives graceful runtime-generation replacement between turns", async () => {
    // The first segment completes cleanly and parks on an elicitation. The
    // runtime generation is then gracefully replaced before the user answers.
    // Durable stores remain shared; the replacement reports the ended ephemeral
    // session to the model, which starts a fresh ephemeral flow.
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
      expect(outcome.runError, "replacing the runtime must not surface a run error").toBe(false);
      expect(outcome.completed, "booking must survive runtime replacement").toBe(true);
      expect(
        outcome.ephemeralStarts,
        "the model restarts the ephemeral flow after the ended session is reported",
      ).toBe(2);
    } finally {
      await runtime.close();
      await substrate.close();
    }
  }, 30_000);
});
