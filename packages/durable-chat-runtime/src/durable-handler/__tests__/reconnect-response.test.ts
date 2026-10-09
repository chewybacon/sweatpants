import { run, type Operation } from "effection";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationStreamEvent } from "@sweatpants/chat-core";
import type { SessionRegistry } from "../../response-streams/index.ts";
import type { ConversationHead } from "@sweatpants/history-store/contract";
import type { ProgramDriverJournalStore, ProgramDriverJournal } from "../program-driver-journal.ts";
import { reconnectResponse, waitForForeignActivation } from "../reconnect-response.ts";

describe("response reconnect after host loss", () => {
  it("selects durable recovery without requiring the lost response buffer", async () => {
    let acquisitions = 0;
    const registry: SessionRegistry<ConversationStreamEvent> = {
      *acquire() {
        acquisitions += 1;
        throw new Error("Session not found and no source provided");
      },
      *release() {
        throw new Error("No response reader was acquired");
      },
    };
    const result = await run(() =>
      reconnectResponse("active-execution", registry, "lost-tail", undefined),
    );
    expect(result.session).toBeUndefined();
    expect(result.recoverDetachedSession).toBe(true);
    expect(acquisitions).toBe(0);
  });
});

describe("foreign request-scoped activation reconnect", () => {
  afterEach(() => vi.useRealTimers());
  const running = {
    state: "running",
    activeExecutionId: "execution",
  } as ConversationHead;

  function journalStore(remaining: () => number): ProgramDriverJournalStore {
    return {
      *withJournal<T>(_id: string, operation: (journal: ProgramDriverJournal) => Operation<T>) {
        return yield* operation({
          *query(query: { type: string }) {
            expect(query.type).toBe("control.activation-status");
            return { remainingMs: remaining() };
          },
        } as unknown as ProgramDriverJournal);
      },
    } as unknown as ProgramDriverJournalStore;
  }

  it("hydrates the completed head instead of taking over a still-live foreign writer", async () => {
    vi.useFakeTimers();
    const completed = { state: "idle", activeExecutionId: null } as ConversationHead;
    let reads = 0;
    const task = run(() =>
      waitForForeignActivation({
        head: running,
        conversationId: "thread",
        liveActivations: new Map(),
        journalStore: journalStore(() => 30_000),
        conversationStore: {
          *loadHead() {
            reads += 1;
            return completed;
          },
        },
      }),
    );
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await task).toBe(completed);
    expect(reads).toBe(1);
  });

  it("returns an abandoned running head for journal recovery exactly when its lease expires", async () => {
    vi.useFakeTimers();
    const expiresAt = Date.now() + 1_500;
    let reads = 0;
    const task = run(() =>
      waitForForeignActivation({
        head: running,
        conversationId: "thread",
        liveActivations: new Map(),
        journalStore: journalStore(() => Math.max(0, expiresAt - Date.now())),
        conversationStore: {
          *loadHead() {
            reads += 1;
            return running;
          },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_499);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await task).toBe(running);
    expect(reads).toBe(3);
  });

  it("notices a released lease before its original expiry and selects recovery", async () => {
    vi.useFakeTimers();
    let remaining = 30_000;
    let observations = 0;
    const task = run(() =>
      waitForForeignActivation({
        head: running,
        conversationId: "thread",
        liveActivations: new Map(),
        journalStore: journalStore(() => {
          observations += 1;
          return remaining;
        }),
        conversationStore: {
          *loadHead() {
            return running;
          },
        },
      }),
    );
    remaining = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await task).toBe(running);
    expect(observations).toBe(2);
  });

  it.each(["before", "during"])(
    "stops an HTTP reader aborted %s lease observation",
    async (when) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reason = new Error("reader disconnected");
      let observations = 0;
      if (when === "before") {
        controller.abort(reason);
      }
      const task = run(() =>
        waitForForeignActivation({
          head: running,
          conversationId: "thread",
          liveActivations: new Map(),
          signal: controller.signal,
          journalStore: journalStore(() => {
            observations += 1;
            return 30_000;
          }),
          conversationStore: {
            *loadHead() {
              throw new Error("aborted reader must stop");
            },
          },
        }),
      );
      const result = task.catch((error: unknown) => error);
      if (when === "during") {
        controller.abort(reason);
      }
      expect(await result).toBe(reason);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(observations).toBe(when === "before" ? 0 : 1);
    },
  );

  it("cancels waiting with the request scope without polling or taking ownership afterward", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const task = run(() =>
      waitForForeignActivation({
        head: running,
        conversationId: "thread",
        liveActivations: new Map(),
        journalStore: journalStore(() => 30_000),
        conversationStore: {
          *loadHead() {
            reads += 1;
            return running;
          },
        },
      }),
    );
    await task.halt();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(0);
  });
});
