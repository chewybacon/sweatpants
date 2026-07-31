import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createInMemoryBuffer } from "@sweatpants/durable-streams";
import type { ProgramDeliveryEnvelope } from "@sweatpants/model-sampling";

import {
  createProgramDeliveryWriter,
  highestRemoteOriginLsn,
  projectProgramDeliveryEnvelope,
} from "../model-sampling-relay.ts";

function envelope(lsn: number, streamId = "remote-1"): ProgramDeliveryEnvelope {
  return {
    version: 1,
    sessionId: "response-1",
    taskId: "turn-1/task-1",
    pullId: "pull-1",
    messageId: "message-1",
    origin: {
      kind: "agentcore-model-sample",
      streamId,
      lsn,
      producerEpoch: 4,
    },
    event: { type: "TEXT_MESSAGE_CONTENT", delta: String(lsn) },
  };
}

describe("model sampling root relay", () => {
  it("retains private origin identity and derives recovery progress from the root log", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<ProgramDeliveryEnvelope>("response-1");
      const fence = yield* buffer.claimWriter({ ownerId: "host-b", activationEpoch: 2 });
      const delivery = createProgramDeliveryWriter(fence);
      yield* delivery.append([envelope(1), envelope(2), envelope(1, "other")]);
      expect(yield* highestRemoteOriginLsn(buffer, "remote-1")).toBe(2);
      const stored = (yield* buffer.read(0)).tokens[1]!;
      expect(stored.origin).toMatchObject({ streamId: "remote-1", lsn: 2, producerEpoch: 4 });
      expect(projectProgramDeliveryEnvelope(stored)).toEqual({
        type: "TEXT_MESSAGE_CONTENT",
        delta: "2",
      });
    });
  });

  it("rejects stale Host relay writers after source recovery", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<ProgramDeliveryEnvelope>("response-1");
      const oldWriter = yield* buffer.claimWriter({ ownerId: "host-a", activationEpoch: 1 });
      const newWriter = yield* buffer.claimWriter({ ownerId: "host-b", activationEpoch: 2 });
      yield* createProgramDeliveryWriter(newWriter).append([envelope(1)]);
      let code = "";
      try {
        yield* createProgramDeliveryWriter(oldWriter).append([envelope(2)]);
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("stale_token_writer");
      expect((yield* buffer.read(0)).tokens).toHaveLength(1);
    });
  });
});
