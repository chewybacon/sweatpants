import type { Operation } from "effection";

import { createCapabilityKeyring, type CapabilityKeyring } from "@sweatpants/journal-authority";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import type {
  ClaimActivationRequest,
  ClaimActivationResult,
  CompleteTaskRequest,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "@sweatpants/journal-authority";
import type { ResolutionReceipt, DurableProgramManifest } from "@sweatpants/durable-execution";
import type { DurableSemanticRecord, OpenDurableTaskRequest } from "@sweatpants/journal-authority";
import type { AuthorityScenarioDriver } from "@sweatpants/journal-authority/testing";

const manifest: DurableProgramManifest = {
  programId: "conformance.sandbox.elicit-once",
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

/** Backend-neutral authority seam for distributed-host recovery scenarios. */
export interface DurableSandboxConformancePort {
  openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
  claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult>;
  releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult>;
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt>;
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  runnableSessions(): Operation<string[]>;
}

/** Opens independent handles over one backend-owned journal identity. */
export interface DurableSandboxConformanceFactory {
  readonly backendName: string;
  open(options: {
    journalId: string;
    keyring: CapabilityKeyring;
  }): Operation<DurableSandboxConformancePort>;
}

/** One backend-neutral distributed-host scenario. */
export interface DurableSandboxConformanceCase {
  readonly name: string;
  run(): Operation<void>;
}

/** Stable conformance defect without backend-specific internals. */
export class DurableSandboxConformanceError extends Error {
  readonly _tag = "DurableSandboxConformanceError" as const;

  constructor(
    readonly caseName: string,
    readonly detail: string,
  ) {
    super(`Durable sandbox conformance failed in ${caseName}: ${detail}`);
    this.name = "DurableSandboxConformanceError";
  }
}

/** Adapts the process-local authority to the operation-native conformance port. */
export function adaptInMemoryAuthorityForSandboxConformance(
  authority: AuthorityScenarioDriver,
): DurableSandboxConformancePort {
  return {
    *openTask(request) {
      return yield* authority.openTask(request);
    },
    *claimActivation(request) {
      return yield* authority.claimActivation(request);
    },
    *releaseActivation(request) {
      return yield* authority.releaseActivation(request);
    },
    *bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch) {
      return yield* authority.bindProgramAttachment(
        sessionId,
        taskId,
        attachmentId,
        executionEpoch,
      );
    },
    *reserve(request) {
      return yield* authority.reserve(request);
    },
    *resolve(request) {
      return yield* authority.resolve(request);
    },
    *complete(request) {
      return yield* authority.complete(request);
    },
    *readJournal(sessionId) {
      return authority.readJournal(sessionId);
    },
    *runnableSessions() {
      return authority.runnableSessions();
    },
  };
}

/** Shared distributed-host recovery corpus for local, Redis, and future authorities. */
export function createDurableSandboxConformanceCases(
  factory: DurableSandboxConformanceFactory,
): readonly DurableSandboxConformanceCase[] {
  return [
    defineCase(factory, "acknowledged response survives host death and completes once", "none"),
    defineCase(factory, "equal duplicate before recovery preserves one resolution", "immediate"),
    defineCase(
      factory,
      "equal duplicate after runnable observation preserves one resolution",
      "after-runnable-observation",
    ),
  ];
}

type DuplicateSchedule = "none" | "immediate" | "after-runnable-observation";

function defineCase(
  factory: DurableSandboxConformanceFactory,
  name: string,
  duplicateSchedule: DuplicateSchedule,
): DurableSandboxConformanceCase {
  const caseName = `${factory.backendName}: ${name}`;
  const keyring = createCapabilityKeyring(`sandbox-conformance:${factory.backendName}`, [
    { keyId: "active", secret: "sandbox-conformance-secret-at-least-32-bytes" },
  ]);
  const journalId = `sandbox-conformance:${factory.backendName}:${slug(name)}`;
  const sessionId = "sandbox-conformance-session";
  const taskId = "turn-0/root";
  return {
    name,
    *run() {
      const hostA = yield* factory.open({ journalId, keyring });
      const hostB = yield* factory.open({ journalId, keyring });
      const scanner = yield* factory.open({ journalId, keyring });

      yield* hostA.openTask({
        sessionId,
        turnId: "turn-0",
        taskId,
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "unattached",
        audience: "program-runtime",
      });
      const claimA = yield* hostA.claimActivation({ sessionId, ownerId: "host-A" });
      assert(caseName, claimA.status === "claimed", "host A must claim runnable work");
      const boundA = yield* hostA.bindProgramAttachment(
        sessionId,
        taskId,
        "host-A-attachment",
        claimA.epoch,
      );
      const pending = yield* hostA.reserve({
        sessionId,
        turnId: "turn-0",
        taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: boundA.programCapability,
      });
      assert(
        caseName,
        pending.status === "pending" && pending.resolutionCapability !== undefined,
        "elicitation must park with a resolution capability",
      );
      const releasedA = yield* hostA.releaseActivation({
        sessionId,
        ownerId: "host-A",
        epoch: claimA.epoch,
        reason: "parked",
      });
      assert(caseName, releasedA.status === "released", "host A must release parked ownership");

      const first = yield* hostB.resolve({
        capability: pending.resolutionCapability,
        audience: "user:answer",
        outcome: { status: "ok", value: { action: "accept", content: true } },
      });
      assert(
        caseName,
        first.status === "accepted",
        "host B must durably accept the response before disappearing",
      );
      const firstReceipt = first.receipt;

      if (duplicateSchedule === "immediate") {
        yield* assertDuplicate(hostB, pending.resolutionCapability, firstReceipt, caseName);
      }
      const runnable = yield* scanner.runnableSessions();
      assert(
        caseName,
        runnable.includes(sessionId),
        "ownerless response must preserve runnable work",
      );
      if (duplicateSchedule === "after-runnable-observation") {
        yield* assertDuplicate(hostB, pending.resolutionCapability, firstReceipt, caseName);
      }

      // Host B is intentionally never used again after acknowledgement.
      const scannerClaim = yield* scanner.claimActivation({ sessionId, ownerId: "scanner" });
      assert(caseName, scannerClaim.status === "claimed", "scanner must claim recovered work");
      const scannerBound = yield* scanner.bindProgramAttachment(
        sessionId,
        taskId,
        "scanner-attachment",
        scannerClaim.epoch,
      );
      const replayed = yield* scanner.reserve({
        sessionId,
        turnId: "turn-0",
        taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: scannerBound.programCapability,
      });
      assert(
        caseName,
        replayed.status === "resolved" && replayed.outcome.status === "ok",
        "scanner must replay the accepted response",
      );
      yield* scanner.complete({
        sessionId,
        taskId,
        actionIndex: 1,
        outcome: { status: "ok", value: "done" },
        programCapability: scannerBound.programCapability,
      });
      const scannerRelease = yield* scanner.releaseActivation({
        sessionId,
        ownerId: "scanner",
        epoch: scannerClaim.epoch,
        reason: "terminal",
      });
      assert(
        caseName,
        scannerRelease.status === "released",
        "scanner must release terminal ownership",
      );

      const records = yield* hostA.readJournal(sessionId);
      assertEqual(
        caseName,
        records.filter((record) => record.payload.type === "PullResolved").length,
        1,
        "journal must contain exactly one pull resolution",
      );
      assertEqual(
        caseName,
        records.filter((record) => record.payload.type === "TaskClosed").length,
        1,
        "journal must contain exactly one task close",
      );
    },
  };
}

function* assertDuplicate(
  authority: DurableSandboxConformancePort,
  capability: string,
  firstReceipt: ResolutionReceipt,
  caseName: string,
): Operation<void> {
  const duplicate = yield* authority.resolve({
    capability,
    audience: "user:answer",
    outcome: { status: "ok", value: { action: "accept", content: true } },
  });
  assert(caseName, duplicate.status === "duplicate", "equal response must deduplicate");
  assertEqual(
    caseName,
    duplicate.receipt.resolutionOffset,
    firstReceipt.resolutionOffset,
    "duplicate must return the first resolution offset",
  );
}

function assertEqual(caseName: string, actual: unknown, expected: unknown, detail: string): void {
  assert(caseName, actual === expected, detail);
}

function assert(caseName: string, condition: boolean, detail: string): asserts condition {
  if (!condition) {
    throw new DurableSandboxConformanceError(caseName, detail);
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
