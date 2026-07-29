import type { ModelSampleRequest } from "@sweatpants/durable-effects";
import { MODEL_SAMPLE_EFFECT } from "@sweatpants/durable-effects";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { canonicalSnapshot } from "@sweatpants/foundation";

import { createInMemoryPlacementModelSampler } from "../in-memory-placement-model-sampler.ts";
import { runPlacementModelSampleProducer } from "../placement-model-producer.ts";
import {
  createPlacementSamplingAuthorizationIssuer,
  verifyPlacementSamplingAuthorization,
} from "../placement-sampling-authorization.ts";
import {
  AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
  createPlacementModelSamplingService,
  type PlacementModelSampler,
  type RemoteSampleAttachment,
} from "../placement-model-sampler.ts";

const identity = {
  journalId: "journal",
  journalIncarnation: "1",
  sessionId: "session",
  taskId: "turn-1/task-1",
  pullId: "pull-1",
};
const request: ModelSampleRequest = {
  messages: [{ role: "user", content: "hello" }],
  classifications: ["private"],
};
const requestDigest = canonicalSnapshot(request).sha;
const contractDigest = effectContractDigest(MODEL_SAMPLE_EFFECT);

function attachRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
    identity,
    attemptId: "a",
    releaseId: "release-1",
    request,
    requestDigest,
    effectContractDigest: contractDigest,
    authorization: "valid",
    ...overrides,
  } as never;
}

describe("in-memory placement model sampler", () => {
  it("issues bounded pull-scoped authorization and rejects expiry or claim mismatch", async () => {
    let now = 5_000;
    const keyring = createCapabilityKeyring("host", [{ keyId: "k1", secret: "x".repeat(32) }]);
    const issuer = createPlacementSamplingAuthorizationIssuer({
      keyring,
      now: () => now,
      ttlMs: 1_000,
    });
    await run(function* () {
      const token = yield* issuer.issue({
        identity,
        attemptId: "a",
        releaseId: "release-1",
        requestDigest,
        effectContractDigest: contractDigest,
        classifications: ["private"],
      });
      const expected = {
        identity,
        releaseId: "release-1",
        requestDigest,
        effectContractDigest: contractDigest,
        classifications: ["private"],
      };
      expect(
        verifyPlacementSamplingAuthorization({ token, keyring, expected, now: () => now }),
      ).toMatchObject({ identity, permissions: ["sample:attach", "sample:read", "sample:cancel"] });
      now = 6_001;
      expect(() =>
        verifyPlacementSamplingAuthorization({ token, keyring, expected, now: () => now }),
      ).toThrowError(expect.objectContaining({ code: "remote_sample_unauthorized" }));
    });
  });
  it("drains one authorized provider through the fenced remote writer", async () => {
    const sampler = createInMemoryPlacementModelSampler({
      releaseId: "release-1",
      authorize: () => true,
    });
    await run(function* () {
      const attached = yield* sampler.attach(attachRequest());
      const disposition = yield* runPlacementModelSampleProducer({
        store: sampler,
        provider: {
          *sample(_request, context) {
            yield* context.emit({ event: { type: "delta", value: "a" } });
            yield* context.emit({ event: { type: "delta", value: "b" } });
            return { status: "ok", value: { text: "ab", calls: [], content: [] } };
          },
        },
        identity,
        modelRequest: request,
        ownerId: "attempt:a",
        producerEpoch: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        cancellation: new AbortController().signal,
      });
      expect(disposition).toMatchObject({ status: "ok", value: { text: "ab" } });
      expect(yield* sampler.read({ version: 1, attachment: attached, afterLsn: 0 })).toMatchObject({
        lsn: 2,
        state: "completed",
        terminalLsn: 2,
      });
    });
  });

  it("relays from a recoverable remote origin cursor without owning a crank", async () => {
    let acknowledged = "";
    let attachCount = 0;
    const remoteAttachment: RemoteSampleAttachment = {
      identity,
      releaseId: "release-1",
      streamId: "remote-stream",
      producerEpoch: 3,
      state: "completed",
      terminalLsn: 2,
    };
    const sampler: PlacementModelSampler = {
      *attach() {
        attachCount += 1;
        return remoteAttachment;
      },
      *read({ afterLsn }) {
        const events = [1, 2]
          .filter((lsn) => lsn > afterLsn)
          .map((lsn) => ({
            version: 1 as const,
            streamId: "remote-stream",
            lsn,
            producerEpoch: 3,
            taskId: identity.taskId,
            pullId: identity.pullId,
            event: { type: "delta", value: lsn },
          }));
        return { events, lsn: 2, state: "completed" as const, terminalLsn: 2 };
      },
      *waitForChange() {},
      *disposition() {
        return { status: "ok", value: { text: "done", calls: [], content: [] } };
      },
      *cancel() {},
      *acknowledge({ outcomeDigest }) {
        acknowledged = outcomeDigest;
      },
    };
    const relayed: unknown[] = [];
    const service = createPlacementModelSamplingService({
      sampler,
      authorization: {
        *issue() {
          return "authorized";
        },
      },
      releaseId: () => "release-1",
      resumeAfter: function* () {
        return 1;
      },
    });
    await run(function* () {
      const disposition = yield* service.sample(request, {
        placement: {
          journal: { id: identity.journalId, incarnation: identity.journalIncarnation },
          program: { id: "p", version: "1", digest: "a".repeat(64) },
          route: { driverKind: "agentcore" },
          driverKind: "agentcore",
        },
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        pullId: identity.pullId,
        attemptId: "a",
        effectContractDigest: contractDigest,
        cancellation: new AbortController().signal,
        delivery: {
          *append(events) {
            relayed.push(...events);
            return events.length;
          },
        },
      });
      expect(disposition).toMatchObject({ status: "ok", value: { text: "done" } });
      expect(relayed).toHaveLength(1);
      expect(relayed[0]).toMatchObject({
        origin: { streamId: "remote-stream", lsn: 2, producerEpoch: 3 },
      });
      const digest = canonicalSnapshot(disposition).sha;
      yield* service.acknowledge(identity, digest);
      expect(acknowledged).toBe(digest);
      expect(attachCount).toBe(1);
    });
  });

  it("attaches idempotently, publishes ordered events, and acknowledges the exact outcome", async () => {
    const sampler = createInMemoryPlacementModelSampler({
      releaseId: "release-1",
      authorize: ({ authorization }) => authorization === "valid",
    });
    await run(function* () {
      const first = yield* sampler.attach(attachRequest());
      const duplicate = yield* sampler.attach(attachRequest());
      expect(duplicate.streamId).toBe(first.streamId);
      expect(duplicate.producerEpoch).toBe(first.producerEpoch);

      const fence = yield* sampler.claimProducer(identity, {
        ownerId: "attempt:a",
        producerEpoch: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      yield* sampler.append(identity, fence, [
        { event: { type: "TEXT_MESSAGE_START" }, messageId: "m" },
        { event: { type: "TEXT_MESSAGE_CONTENT", delta: "hi" }, messageId: "m" },
      ]);
      const page = yield* sampler.read({ version: 1, attachment: first, afterLsn: 0 });
      expect(page.events.map((event) => event.lsn)).toEqual([1, 2]);
      const disposition = {
        status: "ok" as const,
        value: { text: "hi", calls: [], content: [] },
      };
      yield* sampler.publishDisposition(identity, fence, disposition);
      const terminal = yield* sampler.read({ version: 1, attachment: first, afterLsn: 2 });
      expect(terminal).toMatchObject({ state: "completed", terminalLsn: 2 });
      expect(yield* sampler.disposition({ version: 1, attachment: first })).toEqual(disposition);
      const digest = canonicalSnapshot(disposition).sha;
      yield* sampler.acknowledge({ version: 1, attachment: first, outcomeDigest: digest });
      expect((yield* sampler.inspect(identity))?.acknowledgedOutcomeDigest).toBe(digest);
    });
  });

  it("rejects authorization, request conflicts, stale producer writes, and wrong acknowledgements", async () => {
    const sampler = createInMemoryPlacementModelSampler({
      releaseId: "release-1",
      authorize: ({ authorization }) => authorization === "valid",
    });
    await run(function* () {
      let rejected = "";
      try {
        yield* sampler.attach(attachRequest({ authorization: "bad" }));
      } catch (error) {
        rejected = (error as { code?: string }).code ?? "";
      }
      expect(rejected).toBe("remote_sample_unauthorized");

      const attached = yield* sampler.attach(attachRequest());
      try {
        yield* sampler.attach(attachRequest({ requestDigest: "f".repeat(64) }));
      } catch (error) {
        expect((error as { code?: string }).code).toMatch(/protocol|conflict/);
      }
      const newer = yield* sampler.claimProducer(identity, {
        ownerId: "producer-b",
        producerEpoch: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      yield* sampler.append(identity, newer, [{ event: { delta: "new" } }]);
      let stale = "";
      try {
        yield* sampler.append(identity, { ownerId: "attempt:a", producerEpoch: 1 }, [
          { event: { delta: "old" } },
        ]);
      } catch (error) {
        stale = (error as { code?: string }).code ?? "";
      }
      expect(stale).toBe("stale_token_writer");
      const disposition = {
        status: "ok" as const,
        value: { text: "new", calls: [], content: [] },
      };
      yield* sampler.publishDisposition(identity, newer, disposition);
      let acknowledgeConflict = "";
      try {
        yield* sampler.acknowledge({
          version: 1,
          attachment: attached,
          outcomeDigest: "0".repeat(64),
        });
      } catch (error) {
        acknowledgeConflict = (error as { code?: string }).code ?? "";
      }
      expect(acknowledgeConflict).toBe("remote_sample_conflict");
    });
  });

  it("classifies expired producers as orphaned without replacing the generation", async () => {
    let now = 1_000;
    const sampler = createInMemoryPlacementModelSampler({
      releaseId: "release-1",
      authorize: () => true,
      now: () => now,
      producerLeaseMs: 10,
    });
    await run(function* () {
      const attached = yield* sampler.attach(attachRequest());
      now = 1_011;
      expect((yield* sampler.inspect(identity))?.state).toBe("orphaned");
      const duplicate = yield* sampler.attach(attachRequest());
      expect(duplicate).toMatchObject({ streamId: attached.streamId, state: "orphaned" });
    });
  });
});
