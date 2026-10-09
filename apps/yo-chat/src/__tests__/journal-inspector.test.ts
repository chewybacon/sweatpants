import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";
import { type DurableProgramManifest } from "@sweatpants/durable-execution";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";

import { inspectProgramDriverJournal } from "../server/journal-inspector";

const manifest: DurableProgramManifest = {
  programId: "journal-inspector.fixture",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

describe("ProgramDriver journal inspector", () => {
  it("returns a summarized, redacted semantic journal", async () => {
    const store = createProgramDriverJournalStore({
      keyring: createCapabilityKeyring("journal-inspector", [
        { keyId: "test", secret: "journal-inspector-key-is-32-bytes" },
      ]),
      executionStore: createMemoryExecutionStore(),
    });
    await run(function* () {
      yield* store.withJournal("conversation-inspect", (journal) =>
        journal.openTask({
          sessionId: "conversation-inspect",
          turnId: "turn-0",
          taskId: "turn-0/root",
          manifest,
          input: { secret: "must-not-leak", visible: "okay" },
          executionEpoch: 1,
          attachmentId: "inspector-attachment",
          audience: "workflow-host",
        }),
      );
    });

    const inspected = await inspectProgramDriverJournal("conversation-inspect", store);
    expect(inspected.recordCount).toBe(1);
    expect(inspected.summary).toMatchObject({
      taskCount: 1,
      pendingPullIds: [],
      recordsByType: { TaskOpened: 1 },
    });
    expect(JSON.stringify(inspected)).not.toContain("must-not-leak");
    expect(JSON.stringify(inspected)).toContain("[redacted]");
    expect(JSON.stringify(inspected)).toContain("okay");
  });
});
