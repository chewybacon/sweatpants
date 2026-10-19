import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import { canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { expect, it } from "vitest";
import { createKernelExecutionStore } from "../store/store-repository.ts";

it.each(["journal", "replay"] as const)(
  "%s reads own their decoded entries independently of callers and subsequent reads",
  async (kind) => {
    const store = createKernelExecutionStore(createMemoryDurableKernel());
    const entries = [{ nested: { value: "original" } }];
    const canonical = canonicalJson(entries);
    const segment = {
      segmentId: "segment",
      executionId: "execution",
      taskId: "task",
      previous: null,
      firstSequence: "0",
      lastSequence: "0",
      entries,
      contentHash: sha256(canonical),
      encodedBytes: new TextEncoder().encode(canonical).byteLength,
      createdAt: 1,
    };
    const head = await run(() =>
      kind === "journal" ? store.appendJournalSegment(segment) : store.appendReplaySegment(segment),
    );
    const task = { executionId: "execution", taskId: "task", head };
    const first = await run(() =>
      kind === "journal" ? store.readJournal(task) : store.readReplay(task),
    );
    const second = await run(() =>
      kind === "journal" ? store.readJournal(task) : store.readReplay(task),
    );
    const firstChunks: Array<readonly Json[]> = [];
    for await (const chunk of first) {
      firstChunks.push(chunk);
    }
    const exposed = firstChunks[0]![0] as { nested: { value: string } };
    exposed.nested.value = "changed by reader";
    entries[0]!.nested.value = "changed by writer";
    const secondChunks: Array<readonly Json[]> = [];
    for await (const chunk of second) {
      secondChunks.push(chunk);
    }
    expect(secondChunks).toEqual([[{ nested: { value: "original" } }]]);
    const third = await run(() =>
      kind === "journal" ? store.readJournal(task) : store.readReplay(task),
    );
    const thirdChunks: Array<readonly Json[]> = [];
    for await (const chunk of third) {
      thirdChunks.push(chunk);
    }
    expect(thirdChunks).toEqual(secondChunks);
  },
);
