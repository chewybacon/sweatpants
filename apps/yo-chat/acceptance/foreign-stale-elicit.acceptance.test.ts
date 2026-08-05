import { describe, expect, it } from "vitest";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import {
  answerFor,
  createBookFlightSubstrate,
  latestToolCallId,
  post,
  publicInterrupt,
  readJournal,
  type BookFlightSubstrate,
  type PublicEvent,
} from "./fixtures/book-flight-harness.ts";

type Settlement = "accept" | "decline" | "cancel";

function settlementResult(settlement: Settlement): { action: string; content?: unknown } {
  return settlement === "accept" ? answerFor("flight") : { action: settlement };
}

function foreignToolStarts(journal: readonly DurableSemanticRecord[]): number {
  return journal.filter(
    (entry) =>
      entry.payload.type === "PullRequested" &&
      entry.payload.descriptor.kind === "effect" &&
      entry.payload.descriptor.name === "foreign.tool.start",
  ).length;
}

function hasRunError(events: readonly PublicEvent[]): boolean {
  return events.some((event) => event.type === "RUN_ERROR");
}

function hasRunFinished(events: readonly PublicEvent[]): boolean {
  return events.some((event) => event.type === "RUN_FINISHED");
}

function runErrorCode(events: readonly PublicEvent[]): string | undefined {
  const error = events.find((event) => event.type === "RUN_ERROR");
  return typeof error?.["code"] === "string" ? error["code"] : undefined;
}

async function settle(
  substrate: BookFlightSubstrate,
  runtime: { handle(request: Request): Promise<Response> },
  events: PublicEvent[],
): Promise<PublicEvent[]> {
  let current = events;
  let callId = latestToolCallId(current) ?? "call-http-book-flight";
  for (let round = 0; round < 8; round += 1) {
    const pending = publicInterrupt(current);
    if (!pending) {
      return current;
    }
    current = await post(runtime.handle, substrate.conversationId, substrate.messages, {
      interruptId: pending.id,
      result: answerFor(pending.message),
      callId,
    });
    callId = latestToolCallId(current) ?? callId;
  }
  throw new Error("foreign booking did not settle within eight elicitation rounds");
}

async function runStaleForeignElicit(settlement: Settlement): Promise<void> {
  const substrate = await createBookFlightSubstrate({
    conversationId: `foreign-stale-${settlement}`,
  });
  const runtime = substrate.createRuntime();
  try {
    const first = await post(runtime.handle, substrate.conversationId, substrate.messages);
    const pending = publicInterrupt(first);
    expect(pending, "book_flight must park on its first elicitation").toBeDefined();
    const callId = latestToolCallId(first);
    expect(callId).toBeDefined();

    const captured = {
      interruptId: pending!.id,
      result: settlementResult(settlement),
      callId: callId!,
    };

    const settled = await settle(
      substrate,
      runtime,
      await post(runtime.handle, substrate.conversationId, substrate.messages, captured),
    );
    expect(hasRunError(settled)).toBe(false);
    expect(hasRunFinished(settled)).toBe(true);

    const journalBeforeRetry = await readJournal(substrate.journalStore, substrate.conversationId);
    const foreignStartsBeforeRetry = foreignToolStarts(journalBeforeRetry);

    const retry = await post(
      runtime.handle,
      substrate.conversationId,
      substrate.messages,
      captured,
    );
    expect(hasRunError(retry)).toBe(false);
    expect(hasRunFinished(retry)).toBe(true);

    const journalAfterRetry = await readJournal(substrate.journalStore, substrate.conversationId);
    expect(foreignToolStarts(journalAfterRetry)).toBe(foreignStartsBeforeRetry);

    const conflict = await post(runtime.handle, substrate.conversationId, substrate.messages, {
      ...captured,
      result:
        settlement === "accept"
          ? { action: "accept", content: { flightId: "FL002" } }
          : { action: settlement === "decline" ? "accept" : "decline" },
    });
    expect(runErrorCode(conflict)).toBe("RESUME_CONFLICT");

    const journalAfterConflict = await readJournal(
      substrate.journalStore,
      substrate.conversationId,
    );
    expect(foreignToolStarts(journalAfterConflict)).toBe(foreignStartsBeforeRetry);
  } finally {
    await runtime.close();
    await substrate.close();
  }
}

describe("single foreign elicitation stale-client semantics", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "%s remains idempotent and conflict-safe",
    async (settlement) => {
      await runStaleForeignElicit(settlement);
    },
    30_000,
  );
});
