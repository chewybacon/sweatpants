import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { ANY_JSON_SCHEMA_DESCRIPTOR, type ReplayItem } from "@sweatpants/durable-execution";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import type { BindMandateRequest } from "../contract/authority-types.ts";
import { createJournal } from "../shell/journal.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { replayStrand } from "../workflow/replay-walker.ts";

const digest = "a".repeat(64);
function* fixture() {
  const store = createMemoryExecutionStore();
  const options = {
    journalId: "checkpoints",
    keyring: createCapabilityKeyring("test", [{ keyId: "key", secret: "x".repeat(32) }]),
  };
  const journal = yield* createJournal(store, options);
  yield* journal.advance({
    type: "execution.open-task",
    request: {
      sessionId: "session",
      turnId: "turn",
      taskId: "root",
      manifest: {
        programId: "test",
        version: "1",
        digest,
        inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
        outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
        elicits: {},
        effects: {},
        capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
      },
      input: null,
      executionEpoch: 1,
      attachmentId: "original",
      audience: "host",
    },
  });
  const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
  const [item] = plan.replay;
  const request = {
    address: item.address,
    strand: item.strand,
    program: item.program,
    attachmentId: "fresh",
    ownerId: "owner",
    leaseDurationMs: 30_000,
    placement: {
      route: { kind: "local", driverKind: "program", route: { driverKind: "program" } },
      evaluatorKind: "program",
      sandbox: { mode: "allocate" },
    },
    expected: {
      strandHeadDigest: item.plannedHead.digest,
      leaseEpoch: item.executionEpoch,
      forkGroupRevision: item.groupContext.groupRevision,
    },
    frontierProof: {
      frontierDigest: "b".repeat(64),
      strandHeadDigest: item.plannedHead.digest,
      replayedThroughActionIndex: item.replayedThroughActionIndex,
      replayChainDigest: item.replayChainDigest,
      cancellationReplayed: false,
    },
    checkpoint: {
      kind: "continuation",
      format: "test-v1",
      programDigest: digest,
      state: { local: 42 },
    },
  } satisfies BindMandateRequest;
  return { store, options, journal, item, request };
}

describe("authority-owned continuation publication", () => {
  it("persists an owned checkpoint and authority-derived anchor across a stored shell restart", async () => {
    await run(function* () {
      const { store, options, journal, item, request } = yield* fixture();
      const bound = yield* journal.advance({ type: "execution.bind-mandate", request });
      if (bound.status !== "bound") {
        throw Error("expected bind");
      }
      Reflect.set(request.checkpoint, "state", { local: 0 });
      yield* journal.advance({
        type: "execution.release-mandate",
        request: { mandate: bound.mandate, reason: "scope_exit" },
      });
      const restarted = yield* createJournal(store, options);
      const plan = yield* restarted.query({ type: "forest.replay-plan", sessionId: "session" });
      expect(plan.replay[0].checkpoint).toEqual({
        kind: "continuation",
        format: "test-v1",
        programDigest: digest,
        state: { local: 42 },
        resumeAfter: { actionIndex: -1, replayChainDigest: item.replayChainSeed },
      });
      Reflect.set(plan.replay[0].checkpoint!, "state", null);
      const reread = yield* restarted.query({ type: "forest.replay-plan", sessionId: "session" });
      expect(reread.replay[0].checkpoint!.state).toEqual({ local: 42 });
    });
  });

  for (const mismatch of ["lease_epoch", "strand_head"] as const) {
    it(`does not publish a losing bind's checkpoint (${mismatch})`, async () => {
      await run(function* () {
        const { journal, request } = yield* fixture();
        const before = yield* journal.exportSnapshot();
        const expected =
          mismatch === "lease_epoch"
            ? { ...request.expected, leaseEpoch: 999 }
            : { ...request.expected, strandHeadDigest: "c".repeat(64) };
        const result = yield* journal.advance({
          type: "execution.bind-mandate",
          request: { ...request, expected },
        });
        expect(result).toEqual({ status: "stale", mismatch });
        expect(yield* journal.exportSnapshot()).toEqual(before);
      });
    });
  }

  for (const mismatch of ["program", "chain"] as const) {
    it(`rejects a checkpoint with the wrong ${mismatch} without modifying authority`, async () => {
      await run(function* () {
        const { journal, request } = yield* fixture();
        const before = yield* journal.exportSnapshot();
        const invalid: BindMandateRequest =
          mismatch === "program"
            ? { ...request, checkpoint: { ...request.checkpoint, programDigest: "c".repeat(64) } }
            : {
                ...request,
                frontierProof: { ...request.frontierProof, replayChainDigest: "c".repeat(64) },
              };
        let error: unknown;
        try {
          yield* journal.advance({ type: "execution.bind-mandate", request: invalid });
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: "invalid_command" });
        expect(yield* journal.exportSnapshot()).toEqual(before);
      });
    });
  }

  for (const actionIndex of [-2, 0]) {
    it(`rejects an invalid recovery anchor ${actionIndex} before allocating compute`, async () => {
      await run(function* (): Operation<void> {
        const { item, request } = yield* fixture();
        const invalid: ReplayItem = {
          ...item,
          checkpoint: {
            ...request.checkpoint,
            resumeAfter: { actionIndex, replayChainDigest: item.replayChainSeed },
          },
        };
        let error: unknown;
        try {
          yield* replayStrand(invalid);
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({
          code: "replay_diverged",
          message: "Checkpoint anchor differs from accepted history",
        });
      });
    });
  }
});
