import { describe, expect, it } from "vitest";
import { combine, fold, mapFold, prefilter, runFold } from "../fold.ts";
import {
  indexRecords,
  indexRecordsByHand,
  recordIndexFold,
  type DurableRecord,
} from "./fold-adoption-style.ts";

const records: readonly DurableRecord[] = [
  { kind: "pull", taskId: "t1", pullId: "p1", model: true },
  { kind: "prepared", taskId: "t1", pullId: "p1", messageId: "assistant-1" },
  { kind: "emission", taskId: "t1", event: "text", callId: null },
  { kind: "emission", taskId: "t1", event: "started", callId: "c1" },
  { kind: "emission", taskId: "t1", event: "started", callId: "c2" },
  { kind: "emission", taskId: "t1", event: "completed", callId: "c1" },
  { kind: "pull", taskId: "t2", pullId: "p2", model: false },
  { kind: "emission", taskId: "t2", event: "text", callId: null },
  { kind: "closed", taskId: "t1", status: "error" },
];

function counted(source: readonly DurableRecord[], counter: { visits: number }) {
  return {
    *[Symbol.iterator]() {
      for (const record of source) {
        counter.visits += 1;
        yield record;
      }
    },
  };
}

describe("full Fold adoption on a real derivation shape", () => {
  it("computes the whole index in one traversal", () => {
    const counter = { visits: 0 };
    const index = runFold(recordIndexFold, counted(records, counter));

    expect(counter.visits).toBe(records.length);
    expect([...index.pulls.keys()]).toEqual(["2:t1:p1", "2:t2:p2"]);
    expect(index.unfinished).toEqual(["c2"]);
    expect(index.terminal).toBe("error");
  });

  it("matches the five-loop shape production is written in today", () => {
    expect(indexRecords(records)).toEqual(indexRecordsByHand(records));
  });

  it("resolves a cross-fold dependency without a second traversal", () => {
    const counter = { visits: 0 };
    const index = runFold(recordIndexFold, counted(records, counter));

    // messageIds needs the COMPLETED `prepared` map from a different fold.
    // Previous experiment claimed that forces a second phase; it does not.
    expect(index.messageIds.get(0)).toBe("assistant-1");
    // Every emission takes an ordinal, so t2's text emission is 4. Its task
    // never had a model pull, so it links to nothing.
    expect(index.messageIds.get(4)).toBe(null);
    expect([...index.messageIds.keys()]).toEqual([0, 1, 2, 3, 4]);
    expect(counter.visits).toBe(records.length);
  });

  it("orders correctly even though the dependency resolves after the scan", () => {
    // The link is captured positionally during the scan, so a `prepared`
    // record arriving AFTER its emission still resolves.
    const late: readonly DurableRecord[] = [
      { kind: "pull", taskId: "t1", pullId: "p1", model: true },
      { kind: "emission", taskId: "t1", event: "text", callId: null },
      { kind: "prepared", taskId: "t1", pullId: "p1", messageId: "assistant-late" },
    ];

    expect(indexRecords(late).messageIds.get(0)).toBe("assistant-late");
    expect(indexRecords(late)).toEqual(indexRecordsByHand(late));
  });

  it("map preserves the traversal count", () => {
    const counter = { visits: 0 };
    const counting = fold<DurableRecord, number>(() => {
      let seen = 0;
      return { step: () => void (seen += 1), done: () => seen };
    });
    const doubled = mapFold(counting, (value) => value * 2);

    expect(runFold(doubled, counted(records, counter))).toBe(records.length * 2);
    expect(counter.visits).toBe(records.length);
  });

  it("prefilter narrows the work, not the traversal", () => {
    let steps = 0;
    const counter = { visits: 0 };
    const closedOnly = prefilter(
      (record: DurableRecord): record is Extract<DurableRecord, { kind: "closed" }> =>
        record.kind === "closed",
      fold<Extract<DurableRecord, { kind: "closed" }>, number>(() => ({
        step: () => void (steps += 1),
        done: () => steps,
      })),
    );

    expect(runFold(closedOnly, counted(records, counter))).toBe(1);
    // One record did work; every record was still visited once by the scan.
    expect(steps).toBe(1);
    expect(counter.visits).toBe(records.length);
  });

  it("keeps arity manageable: five members compose without a cast", () => {
    const five = combine({
      a: fold<DurableRecord, number>(() => {
        let n = 0;
        return { step: () => void (n += 1), done: () => n };
      }),
      b: fold<DurableRecord, string[]>(() => {
        const ids: string[] = [];
        return { step: (r) => void ids.push(r.taskId), done: () => ids };
      }),
      c: fold<DurableRecord, Set<string>>(() => {
        const kinds = new Set<string>();
        return { step: (r) => void kinds.add(r.kind), done: () => kinds };
      }),
      d: fold<DurableRecord, boolean>(() => {
        let any = false;
        return { step: (r) => void (any ||= r.kind === "closed"), done: () => any };
      }),
      e: fold<DurableRecord, number>(() => {
        let n = 0;
        return { step: (r) => void (n += r.kind === "emission" ? 1 : 0), done: () => n };
      }),
    });
    const result = runFold(five, records);

    expect(result.a).toBe(records.length);
    expect(result.c.has("prepared")).toBe(true);
    expect(result.d).toBe(true);
    expect(result.e).toBe(5);
  });
});
