import { describe, expect, it } from "vitest";
import { run, scoped, sleep } from "effection";
import type { AttachProgramRequest, ProgramDriver } from "@sweatpants/durable-execution";
import { runDurableDriverRecoveryFixture } from "@sweatpants/journal-authority/testing";
import { useLocalWorkerDurableProgramDriver } from "../local-worker-durable-driver.ts";

const workerUrl = new URL("./fixtures/retained-worker.mjs", import.meta.url);
const request: AttachProgramRequest = {
  sessionId: "retention-test",
  taskId: "turn-0/root",
  input: null,
  program: { id: "probe", version: "1", digest: "a".repeat(64) },
  route: { driverKind: "worker" },
  executionEpoch: 1,
};

// Read the real worker thread identity from the protocol probe fixture.
function thread(attachmentId: string) {
  return attachmentId.split(":")[0];
}

describe("application-scoped durable worker retention", () => {
  it("reuses the worker across activation scopes but opens a fresh attachment", async () => {
    const errors: unknown[] = [];
    await run(function* () {
      const driver = yield* useLocalWorkerDurableProgramDriver({
        workerUrl,
        idleTimeoutMs: 10_000,
        onWorkerError: (error) => errors.push(error),
      });
      const first = yield* scoped(function* () {
        const attachment = yield* driver.attach(request);
        yield* driver.shutdown(attachment, "parked");
        return attachment;
      });
      const second = yield* scoped(function* () {
        const attachment = yield* driver.attach({ ...request, executionEpoch: 2 });
        expect(thread(attachment.attachmentId)).toBe(thread(first.attachmentId));
        expect(attachment.attachmentId).not.toBe(first.attachmentId);
        expect(attachment.attachmentId.split(":")[1]).toBe("2");
        yield* driver.shutdown(attachment, "completed");
        return attachment;
      });
      const third = yield* driver.attach(request);
      expect(thread(third.attachmentId)).not.toBe(thread(second.attachmentId));
      yield* driver.shutdown(third, "completed");
    });
    expect(errors).toEqual([]);
  });

  it("keeps immediate teardown as the zero-timeout behavior", async () => {
    await run(function* () {
      const driver = yield* useLocalWorkerDurableProgramDriver({ workerUrl, idleTimeoutMs: 0 });
      const first = yield* scoped(function* () {
        const attachment = yield* driver.attach(request);
        yield* driver.shutdown(attachment, "parked");
        return attachment;
      });
      const next = yield* driver.attach(request);
      expect(thread(next.attachmentId)).not.toBe(thread(first.attachmentId));
      yield* driver.shutdown(next, "completed");
    });
  });

  it("expires idle workers, never expires an active attachment, and isolates concurrent attachments", async () => {
    const errors: unknown[] = [];
    await run(function* () {
      const driver = yield* useLocalWorkerDurableProgramDriver({
        workerUrl,
        idleTimeoutMs: 30,
        onWorkerError: (error) => errors.push(error),
      });
      const initial = yield* driver.attach(request);
      yield* driver.shutdown(initial, "parked");
      const first = yield* driver.attach(request);
      expect(thread(first.attachmentId)).toBe(thread(initial.attachmentId));
      // An old idle deadline must not kill a worker that has been leased again.
      yield* sleep(60);
      const step = yield* driver.step(first, { type: "start", input: null });
      expect(step.type).toBe("completed");
      const concurrent = yield* driver.attach({ ...request, taskId: "other" });
      expect(thread(concurrent.attachmentId)).not.toBe(thread(first.attachmentId));
      yield* driver.shutdown(concurrent, "completed");
      yield* driver.shutdown(first, "parked");
      yield* sleep(60);
      const replacement = yield* driver.attach(request);
      expect(thread(replacement.attachmentId)).not.toBe(thread(first.attachmentId));
      yield* driver.shutdown(replacement, "completed");
    });
    expect(errors).toEqual([]);
  });

  it("discards unclosed attachments on activation teardown and closes the pool with its application", async () => {
    let driver!: ProgramDriver;
    await run(function* () {
      driver = yield* useLocalWorkerDurableProgramDriver({ workerUrl, idleTimeoutMs: 10_000 });
      const abandoned = yield* scoped(() => driver.attach(request));
      const next = yield* driver.attach(request);
      expect(thread(next.attachmentId)).not.toBe(thread(abandoned.attachmentId));
      yield* driver.shutdown(next, "parked");
    });
    await expect(run(() => driver.attach(request))).rejects.toThrow("pool is closed");
  });

  it("replays the real durable generator after park without repeating its settled effect", async () => {
    await run(function* () {
      const driver = yield* useLocalWorkerDurableProgramDriver({
        workerUrl: new URL("./fixtures/durable-program-worker-bootstrap.mjs", import.meta.url),
        idleTimeoutMs: 10_000,
      });
      const evidence = yield* runDurableDriverRecoveryFixture({
        driverKind: "worker",
        createDriver: () => driver,
      });
      expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
      expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
      expect(evidence.attachmentCount).toBe(2);
      expect(evidence.shutdownCount).toBe(2);
      expect(evidence.effectExecutions).toBe(1);
      expect(evidence.attachmentWasProcessless).toBe(true);
    });
  });

  it("reports worker death to the active caller and replaces the failed worker", async () => {
    const errors: unknown[] = [];
    await run(function* () {
      const driver = yield* useLocalWorkerDurableProgramDriver({
        workerUrl,
        idleTimeoutMs: 10_000,
        onWorkerError: (error) => errors.push(error),
      });
      const dead = yield* driver.attach(request);
      let failure: unknown;
      try {
        yield* driver.step(dead, { type: "start", input: "crash" });
      } catch (error) {
        failure = error;
      }
      // A dead worker can close the response channel before its error event arrives.
      expect(failure).toBeInstanceOf(Error);
      const replacement = yield* driver.attach(request);
      expect(thread(replacement.attachmentId)).not.toBe(thread(dead.attachmentId));
      yield* driver.shutdown(replacement, "completed");
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("rejects invalid timeouts", async () => {
    for (const idleTimeoutMs of [-1, NaN, Infinity, 1.5, 2_147_483_648]) {
      await expect(
        run(() => useLocalWorkerDurableProgramDriver({ workerUrl, idleTimeoutMs })),
      ).rejects.toThrow("idleTimeoutMs");
    }
  });
});
