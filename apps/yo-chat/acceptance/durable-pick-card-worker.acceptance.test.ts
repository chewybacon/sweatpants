// @vitest-environment node
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
  type AttachProgramRequest,
  type DurableSemanticRecord,
  type ProgramDriver,
  type ProgramRunResult,
} from "@sweatpants/session-contract";
import { createLocalWorkerDurableProgramDriver } from "@sweatpants/tool-runtime-local";

import type { Card } from "../src/tools/pick-card/cards";
import { durablePickCard, drawPickCards } from "../src/tools/pick-card/durable";
import { createDrawPickCardsRegistration } from "../src/tools/pick-card/durable-effects";

const workerUrl = new URL("./fixtures/durable-pick-card-worker-bootstrap.mjs", import.meta.url);

describe("durable pick_card through the local worker ProgramDriver", () => {
  it("draws once, parks without a worker, and resumes in a fresh worker with the same cards", async () => {
    const keyring = createCapabilityKeyring("durable-pick-card-worker", [
      { keyId: "active", secret: "durable-pick-card-worker-secret-key" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "durable-pick-card-worker",
      journalIncarnation: "1",
      keyring,
    });
    const concrete = createLocalWorkerDurableProgramDriver({
      workerUrl,
      name: "durable-pick-card",
    });
    let activeAttachments = 0;
    let attachmentCount = 0;
    let shutdownCount = 0;
    const driver: ProgramDriver = {
      *attach(request) {
        const attachment = yield* concrete.attach(request);
        activeAttachments += 1;
        attachmentCount += 1;
        return attachment;
      },
      *step(attachment, command) {
        return yield* concrete.step(attachment, command);
      },
      *shutdown(attachment, reason) {
        try {
          yield* concrete.shutdown(attachment, reason);
        } finally {
          activeAttachments -= 1;
          shutdownCount += 1;
        }
      },
    };
    const drivers = createProgramDriverRegistry([["worker", driver]]);
    const effects = createDurableEffectRegistry([createDrawPickCardsRegistration()]);
    const sessionId = "durable-pick-card-worker-session";
    const taskId = "turn-0/root";
    const attach: AttachProgramRequest = {
      sessionId,
      taskId,
      program: {
        id: durablePickCard.manifest.programId,
        version: durablePickCard.manifest.version,
        digest: durablePickCard.manifest.digest,
      },
      input: { count: 3, toolCallId: "call-durable-pick-card" },
      route: { driverKind: "worker", profile: "yo-chat-durable-tools" },
      executionEpoch: 1,
    };

    await run(function* () {
      yield* authority.openTask({
        sessionId,
        turnId: "turn-0",
        taskId,
        manifest: durablePickCard.manifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: "unattached-pick-card",
        audience: "program-runtime",
      });

      expect(yield* runProgram(attach, authority, drivers, effects)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      expect(activeAttachments).toBe(0);
      expect(attachmentCount).toBe(1);
      expect(shutdownCount).toBe(1);

      const beforeRecovery = authority.readJournal(sessionId);
      const drawResult = resolvedDrawCards(beforeRecovery);
      const pending = pendingPickCard(beforeRecovery);
      const projectedCards = elicitedCards(pending);
      expect(drawResult).toHaveLength(3);
      expect(projectedCards).toEqual(drawResult);

      const selected = drawResult[1]!;
      const capability = authority.resolutionCapability(sessionId, taskId, pending.pullId);
      expect(
        yield* authority.resolve({
          capability,
          audience: "user:pickCard",
          outcome: {
            status: "ok",
            value: { action: "accept", content: { picked: selected } },
          },
        }),
      ).toMatchObject({ status: "accepted" });

      authority = createInMemoryDurableJournalAuthority({
        journalId: "durable-pick-card-worker",
        journalIncarnation: "1",
        keyring,
        snapshot: authority.exportSnapshot(),
      });
      expect(yield* runProgram(attach, authority, drivers, effects)).toEqual({
        state: "completed",
        value: expect.stringContaining(
          `the user picked ${selected.rank} of ${selected.suit} (${selected.display})`,
        ),
      });
    });

    expect(activeAttachments).toBe(0);
    expect(attachmentCount).toBe(2);
    expect(shutdownCount).toBe(2);
    const journal = authority.readJournal(sessionId);
    expect(
      journal.filter(
        (record) =>
          record.payload.type === "PullRequested" &&
          record.payload.descriptor.kind === "effect" &&
          record.payload.descriptor.name === drawPickCards.name,
      ),
    ).toHaveLength(1);
    expect(
      journal.filter(
        (record) => record.payload.type === "AttemptStarted" && record.payload.taskId === taskId,
      ),
    ).toHaveLength(1);
    expect(journal.at(-1)?.payload).toMatchObject({
      type: "TaskClosed",
      taskId,
      outcome: { status: "ok" },
    });
  }, 10_000);
});

function runProgram(
  attach: AttachProgramRequest,
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  drivers: ReturnType<typeof createProgramDriverRegistry>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
): Operation<ProgramRunResult> {
  return ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
      });
    });
  });
}

function pendingPickCard(records: DurableSemanticRecord[]) {
  const resolved = new Set(
    records.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  const record = records.find(
    (candidate) =>
      candidate.payload.type === "PullRequested" &&
      candidate.payload.descriptor.kind === "elicit" &&
      candidate.payload.descriptor.key === "pickCard" &&
      !resolved.has(candidate.payload.pullId),
  );
  if (record?.payload.type !== "PullRequested" || record.payload.descriptor.kind !== "elicit") {
    throw new Error("Durable pick_card did not park on its elicitation");
  }
  return record.payload;
}

function resolvedDrawCards(records: DurableSemanticRecord[]): Card[] {
  const resolution = records.find(
    (record) =>
      record.payload.type === "PullResolved" &&
      requestFor(records, record.payload.pullId)?.descriptor.kind === "effect" &&
      requestFor(records, record.payload.pullId)?.descriptor.kind === "effect" &&
      requestFor(records, record.payload.pullId)?.descriptor.name === drawPickCards.name,
  );
  if (resolution?.payload.type !== "PullResolved" || resolution.payload.outcome.status !== "ok") {
    throw new Error("Durable card draw was not resolved");
  }
  const value = resolution.payload.outcome.value;
  if (!isRecord(value) || !Array.isArray(value["cards"])) {
    throw new Error("Durable card draw returned invalid evidence");
  }
  return value["cards"] as Card[];
}

function elicitedCards(pending: ReturnType<typeof pendingPickCard>): Card[] {
  const context = pending.descriptor.context;
  if (
    !isRecord(context) ||
    !isRecord(context["context"]) ||
    !Array.isArray(context["context"]["cards"])
  ) {
    throw new Error("Durable pick_card elicitation omitted card context");
  }
  return context["context"]["cards"] as Card[];
}

function requestFor(records: DurableSemanticRecord[], pullId: string) {
  const record = records.find(
    (candidate) =>
      candidate.payload.type === "PullRequested" && candidate.payload.pullId === pullId,
  );
  return record?.payload.type === "PullRequested" ? record.payload : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
