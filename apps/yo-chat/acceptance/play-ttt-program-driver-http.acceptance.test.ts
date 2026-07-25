import { describe, expect, it } from "vitest";
import {
  createPlayTttSubstrate,
  post,
  publicInterrupt,
  readJournal,
  responsePosition,
} from "./fixtures/play-ttt-harness.ts";

describe("journal-native play_ttt through the HTTP ProgramRuntime", () => {
  it("journals native child sampling and elicitations through game completion", async () => {
    const substrate = await createPlayTttSubstrate({
      conversationId: "play-ttt-program-driver-http",
    });
    const runtime = substrate.createRuntime();
    const { conversationId, messages, journalStore } = substrate;

    try {
      let events = await post(runtime.handle, conversationId, messages);
      for (let round = 0; round < 12; round += 1) {
        const pending = publicInterrupt(events);
        if (!pending) {
          break;
        }
        const journal = await readJournal(journalStore, conversationId);
        const position = responsePosition(journal);
        events = await post(runtime.handle, conversationId, messages, {
          interruptId: pending.id,
          position,
        });
      }

      expect(
        events.some((event) => event.type === "TOOL_CALL_RESULT"),
        JSON.stringify(events),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "TEXT_MESSAGE_CONTENT" && event["delta"] === "Game complete.",
        ),
      ).toBe(true);

      const journal = await readJournal(journalStore, conversationId);
      const effectNames = journal.flatMap((entry) =>
        entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "effect"
          ? [entry.payload.descriptor.name]
          : [],
      );
      expect(effectNames).not.toContain("foreign.tool.start");
      expect(effectNames).not.toContain("foreign.tool.continue");
      expect(effectNames.filter((name) => name === "model.sample").length).toBeGreaterThan(2);
      expect(
        journal.filter(
          (entry) =>
            entry.payload.type === "PullRequested" &&
            entry.payload.descriptor.kind === "record" &&
            entry.payload.descriptor.label === "play-ttt-symbol-coin-flip",
        ),
      ).toHaveLength(1);
      expect(effectNames).not.toContain("tool.execute");
      expect(effectNames).not.toContain("tool.resume");
      expect(journal.at(-1)?.payload.type).toBe("TaskClosed");
      expect(substrate.sampleCount()).toBeGreaterThan(2);
    } finally {
      await runtime.close();
      await substrate.close();
    }
  }, 20_000);
});
