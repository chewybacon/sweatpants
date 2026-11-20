import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { readAcceptedHistoryPage } from "@sweatpan.ts/durable";
import { createJournalPresentation } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: shared history paging retains its captured prefix across append and reopen`, async () => {
    const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
      program: "history-pages",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const task = runtime.start(function* () {
      let journal = store.open();
      function* append(request: string) {
        const state = yield* journal.read();
        const pending = yield* journal.park(state.revision, request);
        if (!pending) {
          throw new Error("Missing request");
        }
        return yield* journal.accept(pending.id, { ok: true, value: request });
      }
      const first = yield* append("first");
      const second = yield* append("second");
      const captured = yield* journal.read();
      const a = yield* readAcceptedHistoryPage(journal.id, captured.history, undefined, 1);
      expect(a.entries).toEqual([first.entry]);
      expect(a.caughtUp).toBe(false);
      const third = yield* append("third");
      const b = yield* readAcceptedHistoryPage(journal.id, captured.history, a.after, 1);
      expect(b.entries).toEqual([second.entry]);
      expect(b.caughtUp).toBe(true);
      const end = yield* readAcceptedHistoryPage(journal.id, captured.history, b.after);
      expect(end.entries).toEqual([]);
      expect(end.after).toEqual(b.after);
      journal = store.reopen();
      const presentation = createJournalPresentation(
        runtime.composition,
        "history-pages/presentation",
        journal,
      );
      const fresh = yield* presentation.operations.read(b.after, 1);
      expect(fresh.entries).toEqual([third.entry]);
      expect(fresh.caughtUp).toBe(true);
      const current = yield* journal.read();
      return { execution: journal.id, history: current.history, cursor: fresh.after };
    });
    onTestFinished(() => task.cancel());
    const { execution, history, cursor } = await task.result;
    const invalid = [
      { ...cursor, execution: "foreign" },
      { ...cursor, position: -1 },
      { ...cursor, position: 0.5 },
      { ...cursor, position: cursor.position + 1 },
      { ...cursor, receipt: "changed" },
      { ...cursor, position: 0, receipt: cursor.receipt },
    ];
    for (const after of invalid) {
      const rejected = runtime.start(function* () {
        return yield* readAcceptedHistoryPage(execution, history, after);
      });
      onTestFinished(() => rejected.cancel());
      await expect(rejected.result).rejects.toThrow(/cursor/i);
    }
    const badLimit = runtime.start(function* () {
      return yield* readAcceptedHistoryPage(execution, history, cursor, 0);
    });
    onTestFinished(() => badLimit.cancel());
    await expect(badLimit.result).rejects.toThrow("page limit");
  });
});
