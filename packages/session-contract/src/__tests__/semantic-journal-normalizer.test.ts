import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
  type DurableProgramManifest,
} from "../index.ts";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/foundation/schema-descriptor";
import type { DurableSemanticRecord } from "../durable-authority.ts";
import {
  normalizeSemanticJournal,
  normalizedSemanticJournalDigest,
} from "../testing/semantic-journal-normalizer.ts";

const manifest: DurableProgramManifest = {
  programId: "fixture.normalizer",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: { answer: { response: ANY_JSON_SCHEMA_DESCRIPTOR } },
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

const baseline: DurableSemanticRecord[] = [
  {
    offset: "7",
    eventId: "backend-event",
    sessionId: "session",
    ownerEpoch: 4,
    payload: {
      type: "TaskClosed",
      taskId: "task",
      outcome: { status: "ok", value: "result" },
    },
  },
];

describe("semantic journal normalizer", () => {
  it("removes only permitted backend and activation coordination fields", () => {
    const runtimeOnlyMutation = structuredClone(baseline);
    runtimeOnlyMutation[0]!.offset = "99";
    runtimeOnlyMutation[0]!.eventId = "other-backend-event";
    runtimeOnlyMutation[0]!.ownerEpoch = 88;
    expect(normalizeSemanticJournal(runtimeOnlyMutation)).toEqual(
      normalizeSemanticJournal(baseline),
    );
  });

  it("normalizes records emitted by the real journal authority", async () => {
    const authority = createInMemoryDurableJournalAuthority({
      journalId: "normalizer",
      keyring: createCapabilityKeyring("normalizer", [
        { keyId: "active", secret: "normalizer-secret-at-least-32-bytes" },
      ]),
    });
    const records = await run(function* () {
      const opened = yield* authority.openTask({
        sessionId: "real-session",
        turnId: "turn",
        taskId: "task",
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "attachment",
        audience: "program-runtime",
      });
      yield* authority.reserve({
        sessionId: "real-session",
        turnId: "turn",
        taskId: "task",
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "elicit",
          key: "answer",
          message: "Answer",
          response: ANY_JSON_SCHEMA_DESCRIPTOR,
        },
        programCapability: opened.programCapability,
      });
      return authority.readJournal("real-session");
    });

    expect(records.map((record) => record.payload.type)).toEqual(["TaskOpened", "PullRequested"]);
    expect(normalizeSemanticJournal(records)).toHaveLength(2);
    expect(normalizedSemanticJournalDigest(records)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retains semantic order, record type, task identity, and canonical outcome", () => {
    const outcomeMutation = structuredClone(baseline);
    outcomeMutation[0]!.payload = {
      type: "TaskClosed",
      taskId: "task",
      outcome: { status: "ok", value: "different" },
    };
    expect(normalizeSemanticJournal(outcomeMutation)).not.toEqual(
      normalizeSemanticJournal(baseline),
    );

    const taskMutation = structuredClone(baseline);
    taskMutation[0]!.payload = {
      type: "TaskClosed",
      taskId: "other-task",
      outcome: { status: "ok", value: "result" },
    };
    expect(normalizeSemanticJournal(taskMutation)).not.toEqual(normalizeSemanticJournal(baseline));
  });
});
