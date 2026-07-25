import { describe, expect, it } from "vitest";
import {
  createPlayTttSubstrate,
  post,
  postAndAbandon,
  publicInterrupt,
  reattach,
  readJournal,
  responsePosition,
  type PlayTttSubstrate,
  type PublicEvent,
} from "./fixtures/play-ttt-harness.ts";
import type { DurableSemanticRecord } from "@sweatpants/session-contract";

/** Observable result of one play_ttt conversation, independent of placement. */
interface PlayOutcome {
  readonly completed: boolean;
  readonly toolResult: boolean;
  readonly coinFlips: number;
  readonly terminalRecord: string | undefined;
  readonly runtimeGenerations: number;
}

/** Drives a conversation to completion on one runtime, with no injected fault. */
async function playToCompletion(substrate: PlayTttSubstrate): Promise<PlayOutcome> {
  const { conversationId, messages, journalStore } = substrate;
  const runtime = substrate.createRuntime();
  try {
    let events: PublicEvent[] = await post(runtime.handle, conversationId, messages);
    for (let round = 0; round < 12; round += 1) {
      const pending = publicInterrupt(events);
      if (!pending) {
        break;
      }
      const journal = await readJournal(journalStore, conversationId);
      events = await post(runtime.handle, conversationId, messages, {
        interruptId: pending.id,
        position: responsePosition(journal),
      });
    }
    return await summarize(substrate, events, 1);
  } finally {
    await runtime.close();
  }
}

/**
 * Abandons the first turn after `frameBudget` frames, destroys the runtime
 * while durable work is still in flight, then drives the conversation to
 * completion on fresh runtimes.
 *
 * Returns `undefined` when the host died before the journal accepted anything.
 * That is not a durability failure: nothing was ever promised, so there is
 * nothing to recover and the client's correct move is to send again. Durable
 * invariance only covers work the authority actually accepted.
 */
async function playThroughAbandonedTurn(
  substrate: PlayTttSubstrate,
  frameBudget: number,
): Promise<PlayOutcome | undefined> {
  const { conversationId, messages, journalStore } = substrate;
  let runtime = substrate.createRuntime();
  let generations = 1;

  try {
    const abandoned = await postAndAbandon(runtime.handle, conversationId, messages, frameBudget);
    expect(abandoned.aborted, `frame budget ${frameBudget} must abandon a live stream`).toBe(true);

    // The host disappears while the activation is still in flight.
    await runtime.close();

    if ((await readJournal(journalStore, conversationId)).length === 0) {
      return undefined;
    }

    runtime = substrate.createRuntime();
    generations += 1;

    // Recovery path: reattach to the existing conversation rather than
    // submitting new input, which would cancel the in-flight turn.
    let events: PublicEvent[] = await reattach(runtime.handle, conversationId);
    for (let round = 0; round < 12; round += 1) {
      const pending = publicInterrupt(events);
      if (!pending) {
        break;
      }
      const journal = await readJournal(journalStore, conversationId);
      const position = responsePosition(journal);
      await runtime.close();
      runtime = substrate.createRuntime();
      generations += 1;
      events = await post(runtime.handle, conversationId, messages, {
        interruptId: pending.id,
        position,
      });
    }
    return await summarize(substrate, events, generations);
  } finally {
    await runtime.close();
  }
}

async function summarize(
  substrate: PlayTttSubstrate,
  events: PublicEvent[],
  generations: number,
): Promise<PlayOutcome> {
  const journal: DurableSemanticRecord[] = await readJournal(
    substrate.journalStore,
    substrate.conversationId,
  );
  return {
    completed: events.some(
      (event) => event.type === "TEXT_MESSAGE_CONTENT" && event["delta"] === "Game complete.",
    ),
    toolResult: events.some((event) => event.type === "TOOL_CALL_RESULT"),
    coinFlips: journal.filter(
      (entry) =>
        entry.payload.type === "PullRequested" &&
        entry.payload.descriptor.kind === "record" &&
        entry.payload.descriptor.label === "play-ttt-symbol-coin-flip",
    ).length,
    terminalRecord: journal.at(-1)?.payload.type,
    runtimeGenerations: generations,
  };
}

describe("play_ttt is invariant under mid-activation host loss", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "reaches the golden outcome after the host disappears at frame %i",
    async (frameBudget) => {
      const golden = await createPlayTttSubstrate({
        conversationId: `ttt-invariance-golden-${frameBudget}`,
      });
      const faulted = await createPlayTttSubstrate({
        conversationId: `ttt-invariance-faulted-${frameBudget}`,
      });

      try {
        const expected = await playToCompletion(golden);
        expect(expected.completed, "golden run must complete").toBe(true);
        expect(expected.coinFlips, "golden run flips the symbol coin once").toBe(1);

        const actual = await playThroughAbandonedTurn(faulted, frameBudget);
        if (!actual) {
          // The host died before the journal accepted anything. Nothing was
          // promised, so nothing was lost. Timing decides whether this window
          // is reachable, so both outcomes are legitimate for a given frame.
          expect(
            (await readJournal(faulted.journalStore, faulted.conversationId)).length,
            "an unrecoverable turn must have journaled nothing at all",
          ).toBe(0);
          return;
        }

        expect(actual.runtimeGenerations).toBeGreaterThan(1);
        expect(actual.completed, "faulted run must still complete").toBe(true);
        expect(actual.toolResult).toBe(expected.toolResult);
        expect(actual.terminalRecord).toBe(expected.terminalRecord);
        expect(actual.coinFlips, "committed coin flip must not re-execute").toBe(
          expected.coinFlips,
        );
      } finally {
        await golden.close();
        await faulted.close();
      }
    },
    30_000,
  );
});
