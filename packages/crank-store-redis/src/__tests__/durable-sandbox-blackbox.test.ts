import { afterEach, describe, expect, it } from "vitest";
import type { RedisClientType } from "redis";

import { createMemoryRedisClient } from "./memory-redis.ts";
import { DurableSandboxSubject } from "./durable-sandbox-subject.ts";

let client: RedisClientType;
afterEach(async () => {
  if (client?.isOpen) await client.disconnect();
});

describe("durable sandbox distributed-host behavior", () => {
  it("Given host A parked an elicit, when host B acknowledges and dies, then scanner A completes exactly once", async () => {
    client = createMemoryRedisClient();
    const subject = new DurableSandboxSubject(
      client,
      `test:${process.pid}:${Date.now()}:two-host:`,
    );

    await subject.givenTask();
    await subject.whenHostAActivatesUntilParked();
    await subject.whenHostBAcceptsResponse();
    expect(subject.acknowledgedPullId).toBeTruthy();
    subject.whenHostBDiesAfterAcknowledgement();
    await subject.whenRecoveryScannerRuns();
    await subject.thenTaskCompletedExactlyOnce();
  });

  for (const duplicateSchedule of ["before-scanner", "after-ack"] as const) {
    it(`preserves one durable response for an equal duplicate ${duplicateSchedule}`, async () => {
      client = createMemoryRedisClient();
      const subject = new DurableSandboxSubject(
        client,
        `test:${process.pid}:${Date.now()}:${duplicateSchedule}:`,
      );
      await subject.givenTask();
      await subject.whenHostAActivatesUntilParked();
      await subject.whenHostBAcceptsResponse();
      await subject.whenHostBAcceptsResponse();
      subject.whenHostBDiesAfterAcknowledgement();
      await subject.whenRecoveryScannerRuns();
      await subject.thenTaskCompletedExactlyOnce();
    });
  }
});
