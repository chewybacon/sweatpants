import type { Operation } from "effection";

import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
  defineDurableEffect,
  type DurableProgramManifest,
  type DurableSemanticRecord,
  type DurableToolRegistry,
  type Json,
  type ProgramDriver,
  type ProgramRoute,
} from "../index.ts";

export interface DurableDriverRecoveryFixtureOptions {
  driverKind: string;
  route?: ProgramRoute;
  createDriver(registry: DurableToolRegistry): ProgramDriver;
}

export interface DurableDriverRecoveryEvidence {
  firstRun: { state: "parked"; pullId: string; reason: string };
  resolutionStatus: "accepted" | "duplicate";
  secondRun: { state: "completed"; value: Json };
  invocationId: string;
  pendingPullId: string;
  normalizedJournal: string[];
  semanticJournal: DurableSemanticRecord[];
  attachmentWasProcessless: boolean;
  attachmentCount: number;
  shutdownCount: number;
  effectExecutions: number;
}

const echoDefinition = defineDurableEffect<string, string>({
  name: "echo",
  version: "1",
  inputSchema: { type: "string" },
  outputSchema: { type: "string" },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const fixtureManifest: DurableProgramManifest = {
  programId: "conformance.recovery-sequence",
  version: "1.0.0",
  digest: "d".repeat(64),
  inputSchema: { type: "string" },
  outputSchema: { type: "string" },
  elicits: {
    approval: { responseSchema: { type: "boolean" } },
  },
  effects: { echo: echoDefinition },
  capabilities: {
    durableEmissions: true,
    structuredChildren: false,
    replay: "strict",
  },
};

/**
 * Shared protocol-neutral integration fixture used by concrete runtime
 * packages. It proves that the concrete driver participates in the real
 * ProgramRuntime/JournalAuthority loop rather than testing adapter methods in
 * isolation.
 */
export function* runDurableDriverRecoveryFixture(
  options: DurableDriverRecoveryFixtureOptions,
): Operation<DurableDriverRecoveryEvidence> {
  let effectExecutions = 0;
  const tool = createDurableTool(fixtureManifest, function* (input, context) {
    const echoed = yield* context.effect(echoDefinition, input, {
      audience: "fixture-effects",
    });
    yield* context.emit("fixture_progress", { echoed });
    const approved = yield* context.elicit<boolean>(
      "approval",
      "Approve the recovered execution?",
      { type: "boolean" },
    );
    return `${echoed}:${approved}`;
  });
  const tools = createDurableToolRegistry([tool]);
  const concreteDriver = options.createDriver(tools);
  let activeAttachments = 0;
  let attachmentCount = 0;
  let shutdownCount = 0;
  const driver: ProgramDriver = {
    *attach(request) {
      const attachment = yield* concreteDriver.attach(request);
      attachmentCount += 1;
      activeAttachments += 1;
      return attachment;
    },
    *step(attachment, command) {
      return yield* concreteDriver.step(attachment, command);
    },
    *shutdown(attachment, reason) {
      try {
        yield* concreteDriver.shutdown(attachment, reason);
      } finally {
        shutdownCount += 1;
        activeAttachments -= 1;
      }
    },
  };
  const drivers = createProgramDriverRegistry([[options.driverKind, driver]]);
  const effects = createDurableEffectRegistry([
    createDurableEffectRegistration(
      echoDefinition,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (input) {
        effectExecutions += 1;
        return input;
      },
    ),
  ]);
  const authority = createInMemoryDurableJournalAuthority({
    journalId: `driver-integration:${options.driverKind}`,
    journalIncarnation: "fixture-1",
    keyring: createCapabilityKeyring("driver-integration", [
      { keyId: "fixture-key", secret: "fixture-secret-32-bytes-minimum!!" },
    ]),
  });
  const invocationId = "turn-0/root";
  const attach = {
    sessionId: `driver-session:${options.driverKind}`,
    taskId: invocationId,
    program: {
      id: fixtureManifest.programId,
      version: fixtureManifest.version,
      digest: fixtureManifest.digest,
    },
    input: "hello",
    route: options.route ?? { driverKind: options.driverKind },
    executionEpoch: 1,
  };
  yield* authority.openTask({
    sessionId: attach.sessionId,
    turnId: "turn-0",
    taskId: attach.taskId,
    manifest: fixtureManifest,
    input: attach.input,
    executionEpoch: attach.executionEpoch,
    attachmentId: "unattached",
    audience: "fixture-program",
  });

  const first = yield* ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({
          attach,
          executeHostEffects: true,
        });
      });
    });
  });
  if (first.state !== "parked") {
    throw new Error(`Expected first durable run to park, received ${first.state}`);
  }

  const parkedJournal = authority.readJournal(attach.sessionId);
  const pending = findPendingElicit(parkedJournal);
  const attachmentWasProcessless = activeAttachments === 0 && shutdownCount === 1;
  const capability = authority.resolutionCapability(
    attach.sessionId,
    attach.taskId,
    pending.payload.pullId,
  );
  const resolution = yield* authority.resolve({
    capability,
    audience: "user:approval",
    outcome: { status: "ok", value: true },
  });
  if (resolution.status === "rejected") {
    throw new Error(`Fixture elicitation resolution failed: ${resolution.code}`);
  }

  const second = yield* ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({
          attach,
          executeHostEffects: true,
        });
      });
    });
  });
  if (second.state !== "completed") {
    throw new Error(`Expected recovered durable run to complete, received ${second.state}`);
  }

  const semanticJournal = authority.readJournal(attach.sessionId);
  return {
    firstRun: first,
    resolutionStatus: resolution.status,
    secondRun: second,
    invocationId,
    pendingPullId: pending.payload.pullId,
    normalizedJournal: semanticJournal.map((record) => record.payload.type),
    semanticJournal,
    attachmentWasProcessless,
    attachmentCount,
    shutdownCount,
    effectExecutions,
  };
}

function findPendingElicit(records: DurableSemanticRecord[]): DurableSemanticRecord & {
  payload: Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }>;
} {
  const resolved = new Set(
    records.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  const pending = records.find(
    (
      record,
    ): record is DurableSemanticRecord & {
      payload: Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }>;
    } =>
      record.payload.type === "PullRequested" &&
      record.payload.descriptor.kind === "elicit" &&
      !resolved.has(record.payload.pullId),
  );
  if (!pending) {
    throw new Error("Fixture did not produce a pending elicitation pull");
  }
  return pending;
}
