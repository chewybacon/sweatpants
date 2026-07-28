import { describe, expect, it } from "vitest";
import { run, spawn, sleep } from "effection";
import {
  createToolSessionEventLog,
  isTerminalToolSessionStatus,
  statusForToolSessionEvent,
} from "./event-log.ts";
import type { ToolSessionEvent } from "./contract.ts";

describe("statusForToolSessionEvent", () => {
  it("maps request and terminal events to their statuses", () => {
    expect(statusForToolSessionEvent({ type: "elicit_request" }, "running")).toBe(
      "awaiting_elicit",
    );
    expect(statusForToolSessionEvent({ type: "sample_request" }, "running")).toBe(
      "awaiting_sample",
    );
    expect(statusForToolSessionEvent({ type: "result" }, "running")).toBe("completed");
    expect(statusForToolSessionEvent({ type: "error" }, "running")).toBe("failed");
    expect(statusForToolSessionEvent({ type: "cancelled" }, "running")).toBe("cancelled");
  });

  it("progress and log only upgrade an initializing session", () => {
    expect(statusForToolSessionEvent({ type: "progress" }, "initializing")).toBe("running");
    expect(statusForToolSessionEvent({ type: "log" }, "initializing")).toBe("running");
    // Never demote an awaiting state.
    expect(statusForToolSessionEvent({ type: "progress" }, "awaiting_elicit")).toBeUndefined();
    expect(statusForToolSessionEvent({ type: "log" }, "running")).toBeUndefined();
  });
});

describe("isTerminalToolSessionStatus", () => {
  it("treats completed, failed, cancelled, and orphaned as terminal", () => {
    expect(isTerminalToolSessionStatus("completed")).toBe(true);
    expect(isTerminalToolSessionStatus("failed")).toBe(true);
    expect(isTerminalToolSessionStatus("cancelled")).toBe(true);
    expect(isTerminalToolSessionStatus("orphaned")).toBe(true);
    expect(isTerminalToolSessionStatus("running")).toBe(false);
    expect(isTerminalToolSessionStatus("awaiting_elicit")).toBe(false);
  });
});

describe("createToolSessionEventLog", () => {
  it("assigns monotonic LSNs and derives status from appended events", () => {
    const log = createToolSessionEventLog();
    log.setStatus("running");

    const first = log.append({ type: "progress", message: "working" });
    const second = log.append({ type: "elicit_request", elicitId: "e1" });
    expect(first.lsn).toBe(1);
    expect(second.lsn).toBe(2);
    expect(log.status).toBe("awaiting_elicit");
    expect(log.lastLsn).toBe(2);

    log.append({ type: "result", result: { ok: true } });
    expect(log.status).toBe("completed");
  });

  it("peekNextLsn reserves the id the next append will use", () => {
    const log = createToolSessionEventLog();
    expect(log.peekNextLsn()).toBe(1);
    const event = log.append({ type: "log", level: "info", message: "x" });
    expect(event.lsn).toBe(1);
    expect(log.peekNextLsn()).toBe(2);
  });

  it("replays buffered events after an LSN cursor and then delivers live events", async () => {
    const log = createToolSessionEventLog();
    log.append({ type: "progress", message: "one" });
    log.append({ type: "progress", message: "two" });

    const seen = await run(function* () {
      const collected: ToolSessionEvent[] = [];
      const task = yield* spawn(function* () {
        const subscription = yield* log.events(1);
        while (true) {
          const next = yield* subscription.next();
          if (next.done) {
            return;
          }
          collected.push(next.value);
        }
      });
      yield* sleep(0);
      log.append({ type: "progress", message: "three" });
      log.close();
      yield* task;
      return collected;
    });

    expect(seen.map((event) => event.lsn)).toEqual([2, 3]);
  });

  it("settled resolves immediately for terminal state and waits otherwise", async () => {
    const log = createToolSessionEventLog();

    const status = await run(function* () {
      const waiting = yield* spawn(() => log.settled());
      yield* sleep(0);
      log.append({ type: "cancelled", reason: "test" });
      return yield* waiting;
    });
    expect(status).toBe("cancelled");

    const immediate = await run(() => log.settled());
    expect(immediate).toBe("cancelled");
  });

  it("closing completes live subscribers after they drain the buffer", async () => {
    const log = createToolSessionEventLog();
    log.append({ type: "result", result: 42 });
    log.close();

    const events = await run(function* () {
      const collected: ToolSessionEvent[] = [];
      const subscription = yield* log.events();
      while (true) {
        const next = yield* subscription.next();
        if (next.done) {
          return collected;
        }
        collected.push(next.value);
      }
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("result");
  });
});
