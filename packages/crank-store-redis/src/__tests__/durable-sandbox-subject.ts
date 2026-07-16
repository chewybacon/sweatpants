import { run } from "effection";
import type { RedisClientType } from "redis";

import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  createCapabilityKeyring,
  type DurableProgramManifest,
  type ResolutionReceipt,
} from "@sweatpants/session-contract";

import { createRedisDurableJournalAuthority } from "../durable-authority.ts";

const manifest: DurableProgramManifest = {
  programId: "bdd.elicit-once",
  version: "1",
  digest: "b".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: { answer: { response: ANY_JSON_SCHEMA_DESCRIPTOR } },
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};
const descriptor = {
  kind: "elicit" as const,
  key: "answer",
  message: "Answer once",
  response: ANY_JSON_SCHEMA_DESCRIPTOR,
};

/** Readable BDD subject: hosts share Redis but no process-local activation state. */
export class DurableSandboxSubject {
  readonly sessionId = "bdd-session";
  readonly taskId = "turn-0/root";
  readonly #hosts: Record<string, ReturnType<typeof createRedisDurableJournalAuthority>>;
  #pendingCapability?: string;
  #pendingPullId?: string;
  #receipt?: ResolutionReceipt;
  #hostBAlive = true;

  constructor(client: RedisClientType, keyPrefix: string) {
    const keyring = createCapabilityKeyring("bdd-subject", [
      { keyId: "bdd", secret: "bdd-subject-secret-at-least-32-bytes" },
    ]);
    const createHost = () =>
      createRedisDurableJournalAuthority(client.duplicate(), {
        journalId: "bdd-journal",
        journalIncarnation: "1",
        keyring,
        keyPrefix,
        now: () => 1_000,
      });
    this.#hosts = { A: createHost(), B: createHost(), scanner: createHost() };
  }

  async givenTask(): Promise<void> {
    await run(() =>
      this.#hosts.A!.openTask({
        sessionId: this.sessionId,
        turnId: "turn-0",
        taskId: this.taskId,
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "unattached",
        audience: "program-runtime",
      }),
    );
  }

  async whenHostAActivatesUntilParked(): Promise<void> {
    await run(
      function* (this: DurableSandboxSubject) {
        const claim = yield* this.#hosts.A!.claimActivation({
          sessionId: this.sessionId,
          ownerId: "host-A",
        });
        if (claim.status !== "claimed") throw new Error(`claim failed: ${claim.status}`);
        const bound = yield* this.#hosts.A!.bindProgramAttachment(
          this.sessionId,
          this.taskId,
          "host-A-attachment",
          claim.epoch,
        );
        const pending = yield* this.#hosts.A!.reserve({
          sessionId: this.sessionId,
          turnId: "turn-0",
          taskId: this.taskId,
          actionIndex: 0,
          pullIndex: 0,
          descriptor,
          programCapability: bound.programCapability,
        });
        if (pending.status !== "pending" || !pending.resolutionCapability) {
          throw new Error("elicit did not park");
        }
        this.#pendingCapability = pending.resolutionCapability;
        this.#pendingPullId = pending.pullId;
        yield* this.#hosts.A!.releaseActivation({
          sessionId: this.sessionId,
          ownerId: "host-A",
          epoch: claim.epoch,
          reason: "parked",
        });
      }.bind(this),
    );
  }

  async whenHostBAcceptsResponse(): Promise<void> {
    if (!this.#hostBAlive || !this.#pendingCapability) throw new Error("host B is unavailable");
    const result = await run(() =>
      this.#hosts.B!.resolve({
        capability: this.#pendingCapability!,
        audience: "user:answer",
        outcome: { status: "ok", value: { action: "accept", content: true } },
      }),
    );
    if (result.status === "rejected") throw new Error(`response rejected: ${result.code}`);
    this.#receipt = result.receipt;
  }

  whenHostBDiesAfterAcknowledgement(): void {
    if (!this.#receipt) throw new Error("response was not acknowledged");
    this.#hostBAlive = false;
  }

  async whenRecoveryScannerRuns(): Promise<void> {
    await run(
      function* (this: DurableSandboxSubject) {
        const runnable = yield* this.#hosts.scanner!.runnableSessions();
        if (!runnable.includes(this.sessionId)) throw new Error("runnable marker was lost");
        const claim = yield* this.#hosts.scanner!.claimActivation({
          sessionId: this.sessionId,
          ownerId: "scanner",
        });
        if (claim.status !== "claimed") throw new Error(`scanner claim failed: ${claim.status}`);
        const bound = yield* this.#hosts.scanner!.bindProgramAttachment(
          this.sessionId,
          this.taskId,
          "scanner-attachment",
          claim.epoch,
        );
        const replayed = yield* this.#hosts.scanner!.reserve({
          sessionId: this.sessionId,
          turnId: "turn-0",
          taskId: this.taskId,
          actionIndex: 0,
          pullIndex: 0,
          descriptor,
          programCapability: bound.programCapability,
        });
        if (replayed.status !== "resolved") throw new Error("accepted response was not replayable");
        yield* this.#hosts.scanner!.complete({
          sessionId: this.sessionId,
          taskId: this.taskId,
          actionIndex: 1,
          outcome: { status: "ok", value: "done" },
          programCapability: bound.programCapability,
        });
        yield* this.#hosts.scanner!.releaseActivation({
          sessionId: this.sessionId,
          ownerId: "scanner",
          epoch: claim.epoch,
          reason: "terminal",
        });
      }.bind(this),
    );
  }

  async thenTaskCompletedExactlyOnce(): Promise<void> {
    const records = await run(() => this.#hosts.A!.readJournal(this.sessionId));
    const closes = records.filter((record) => record.payload.type === "TaskClosed");
    if (closes.length !== 1) throw new Error(`expected one close, received ${closes.length}`);
    const resolutions = records.filter((record) => record.payload.type === "PullResolved");
    if (resolutions.length !== 1) {
      throw new Error(`expected one resolution, received ${resolutions.length}`);
    }
  }

  get acknowledgedPullId(): string | undefined {
    return this.#pendingPullId;
  }
}
