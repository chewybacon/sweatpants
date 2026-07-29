import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  createCapabilityKeyring,
  createInMemoryProgramDriverJournalStore,
} from "@sweatpants/framework/server";
import { type DurableProgramManifest } from "@sweatpants/durable-execution";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/foundation/schema-descriptor";

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
    const store = createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("journal-inspector", [
        { keyId: "test", secret: "journal-inspector-key-is-32-bytes" },
      ]),
    });
    await run(function* () {
      const journal = yield* store.open("conversation-inspect");
      yield* journal.openTask({
        sessionId: "conversation-inspect",
        turnId: "turn-0",
        taskId: "turn-0/root",
        manifest,
        input: { secret: "must-not-leak", visible: "okay" },
        executionEpoch: 1,
        attachmentId: "inspector-attachment",
        audience: "program-runtime",
      });
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
