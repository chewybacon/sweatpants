import type { Operation } from "effection";

import {
  DurableEffectRegistryContext,
  DurableProgramCancellation,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableSchemaRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
  defineDurableEffect,
  type DurableProgramManifest,
  type DurableSchemaRegistryEntry,
  type DurableSemanticRecord,
  type DurableToolRegistry,
  type Json,
  type ProgramDriver,
  type ProgramRoute,
  type ProgramRunResult,
} from "../index.ts";
import { booleanGuard, createSchemaFixture, nullGuard, stringGuard } from "./schema-fixtures.ts";

/** Dependencies for exercising one driver across park, snapshot, and recovery. */
export interface DurableDriverRecoveryFixtureOptions {
  driverKind: string;
  route?: ProgramRoute;
  createDriver(registry: DurableToolRegistry): ProgramDriver;
  /** Exercises authority-claimed restore/ticket behavior used by remote placements. */
  useActivationLease?: boolean;
  sessionId?: string;
}

/** Observable journal and outcome evidence returned by the recovery fixture. */
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

/** Evidence that cancellation was replayed through typed catch/finally cleanup. */
export interface DurableDriverCancellationEvidence {
  firstRun: { state: "parked"; pullId: string; reason: string };
  secondRun: { state: "cancelled" };
  invocationId: string;
  pendingPullId: string;
  normalizedJournal: string[];
  semanticJournal: DurableSemanticRecord[];
  attachmentWasProcessless: boolean;
  attachmentCount: number;
  shutdownCount: number;
  effectExecutions: number;
  cleanupExecutions: number;
  cancellationCatches: number;
}

const echoInput = createSchemaFixture(
  "conformance.echo/input",
  "effect_input",
  { type: "string" },
  stringGuard,
);
const echoOutput = createSchemaFixture(
  "conformance.echo/output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const programInput = createSchemaFixture(
  "conformance.recovery-sequence/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const programOutput = createSchemaFixture(
  "conformance.recovery-sequence/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const approvalResponse = createSchemaFixture(
  "conformance.recovery-sequence/approval-response",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);
const cleanupInput = createSchemaFixture(
  "conformance.cleanup/input",
  "effect_input",
  { type: "null" },
  nullGuard,
);
const cleanupOutput = createSchemaFixture(
  "conformance.cleanup/output",
  "effect_output",
  { type: "null" },
  nullGuard,
);

/** Registry entries for every fixture descriptor used by the driver harness. */
export const DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES: readonly DurableSchemaRegistryEntry[] =
  Object.freeze([
    echoInput.entry,
    echoOutput.entry,
    programInput.entry,
    programOutput.entry,
    approvalResponse.entry,
    cleanupInput.entry,
    cleanupOutput.entry,
  ]);

const echoDefinition = defineDurableEffect<string, string>({
  name: "echo",
  version: "1",
  inputSchema: echoInput.descriptor,
  outputSchema: echoOutput.descriptor,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const fixtureManifest: DurableProgramManifest = {
  programId: "conformance.recovery-sequence",
  version: "1.0.0",
  digest: "d".repeat(64),
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {
    approval: { response: approvalResponse.descriptor },
  },
  effects: { echo: echoDefinition },
  capabilities: {
    durableEmissions: true,
    structuredChildren: false,
    replay: "strict",
  },
};

const cleanupDefinition = defineDurableEffect<null, null>({
  name: "cleanup",
  version: "1",
  inputSchema: cleanupInput.descriptor,
  outputSchema: cleanupOutput.descriptor,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

const cancellationManifest: DurableProgramManifest = {
  ...fixtureManifest,
  programId: "conformance.cancellation-sequence",
  digest: "e".repeat(64),
  effects: { echo: echoDefinition, cleanup: cleanupDefinition },
};

/** Static fixture program loadable by in-process and isolated worker registries. */
export const durableDriverRecoveryFixtureTool = createDurableTool(
  fixtureManifest,
  function* (input, context) {
    const echoed = yield* context.effect(echoDefinition, input, {
      audience: "fixture-effects",
    });
    yield* context.emit("fixture_progress", { echoed });
    const approval = yield* context.elicit<boolean>(
      "approval",
      "Approve the recovered execution?",
      approvalResponse.descriptor,
    );
    const approved = approval.action === "accept" ? approval.content : false;
    return `${echoed}:${approved}`;
  },
);

/** Static cancellation fixture whose catch evidence crosses a durable emission boundary. */
export const durableDriverCancellationFixtureTool = createDurableTool(
  cancellationManifest,
  function* (input, context) {
    const echoed = yield* context.effect(echoDefinition, input, {
      audience: "fixture-effects",
    });
    try {
      yield* context.elicit<boolean>(
        "approval",
        "Approve cancellation fixture?",
        approvalResponse.descriptor,
      );
      return echoed;
    } catch (error) {
      if (error instanceof DurableProgramCancellation) {
        yield* context.emit("cancellation_caught", { caught: true });
      }
      return "caught-cancellation-must-not-be-success";
    } finally {
      yield* context.effect(cleanupDefinition, null, { audience: "fixture-cleanup" });
      yield* context.emit("cleanup_complete", { cleaned: true });
    }
  },
);

/** Exact static program set used by concrete ProgramDriver transport fixtures. */
export const DURABLE_DRIVER_FIXTURE_TOOLS = Object.freeze([
  durableDriverRecoveryFixtureTool,
  durableDriverCancellationFixtureTool,
]);

/**
 * Shared protocol-neutral integration fixture used by concrete runtime
 * packages. It proves that the concrete driver participates in the real
 * ProgramRuntime/JournalAuthority loop rather than testing adapter methods in
 * isolation.
 */
/** Runs a deterministic park/recover scenario through production runtime seams. */
export function* runDurableDriverRecoveryFixture(
  options: DurableDriverRecoveryFixtureOptions,
): Operation<DurableDriverRecoveryEvidence> {
  let effectExecutions = 0;
  const tools = createDurableToolRegistry([durableDriverRecoveryFixtureTool]);
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
    ...(concreteDriver.restore
      ? {
          *restore(request) {
            const restored = yield* concreteDriver.restore!(request);
            attachmentCount += 1;
            activeAttachments += 1;
            return restored;
          },
        }
      : {}),
  };
  const drivers = createProgramDriverRegistry([[options.driverKind, driver]]);
  const effects = createDurableEffectRegistry([
    createDurableEffectRegistration(
      echoDefinition,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (input) {
        effectExecutions += 1;
        return { status: "ok", value: input };
      },
    ),
  ]);
  const authority = createInMemoryDurableJournalAuthority({
    journalId: `driver-integration:${options.driverKind}`,
    journalIncarnation: "fixture-1",
    keyring: createCapabilityKeyring("driver-integration", [
      { keyId: "fixture-key", secret: "fixture-secret-32-bytes-minimum!!" },
    ]),
    schemaRegistry: createDurableSchemaRegistry([...DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES]),
  });
  const invocationId = "turn-0/root";
  const attach = {
    sessionId: options.sessionId ?? `driver-session:${options.driverKind}`,
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

  let activationCount = 0;
  const activate = function* (): Operation<ProgramRunResult> {
    activationCount += 1;
    const ownerId = `fixture-owner-${activationCount}`;
    const claim = options.useActivationLease
      ? yield* authority.claimActivation({ sessionId: attach.sessionId, ownerId })
      : undefined;
    if (claim && claim.status !== "claimed") {
      throw new Error(`Fixture activation claim failed: ${claim.status}`);
    }
    const executionEpoch = claim?.status === "claimed" ? claim.epoch : attach.executionEpoch;
    let releaseReason: "parked" | "terminal" | "failed" = "failed";
    try {
      const outcome = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* JournalAuthorityContext.with(authority, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* ProgramRuntime.operations.run({
              attach: { ...attach, executionEpoch },
              executeHostEffects: true,
              ...(claim?.status === "claimed" ? { activationOwnerId: ownerId } : {}),
            });
          });
        });
      });
      releaseReason = outcome.state === "parked" ? "parked" : "terminal";
      return outcome;
    } finally {
      if (claim?.status === "claimed") {
        yield* authority.releaseActivation({
          sessionId: attach.sessionId,
          ownerId,
          epoch: claim.epoch,
          reason: releaseReason,
        });
      }
    }
  };

  const first = yield* activate();
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
    outcome: { status: "ok", value: { action: "accept", content: true } },
  });
  if (resolution.status === "rejected") {
    throw new Error(`Fixture elicitation resolution failed: ${resolution.code}`);
  }

  const second = yield* activate();
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

/** Runs processless cancellation through the concrete driver and normal cleanup effects. */
export function* runDurableDriverCancellationFixture(
  options: DurableDriverRecoveryFixtureOptions,
): Operation<DurableDriverCancellationEvidence> {
  let effectExecutions = 0;
  let cleanupExecutions = 0;
  const tools = createDurableToolRegistry([durableDriverCancellationFixtureTool]);
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
        return { status: "ok", value: input };
      },
    ),
    createDurableEffectRegistration(
      cleanupDefinition,
      { mode: "idempotent", mechanism: "inherent" },
      function* () {
        cleanupExecutions += 1;
        return { status: "ok", value: null };
      },
    ),
  ]);
  const keyring = createCapabilityKeyring("driver-cancellation-integration", [
    { keyId: "fixture-key", secret: "driver-cancellation-secret-32-bytes!!" },
  ]);
  let authority = createInMemoryDurableJournalAuthority({
    journalId: `driver-cancellation-integration:${options.driverKind}`,
    journalIncarnation: "fixture-1",
    keyring,
    schemaRegistry: createDurableSchemaRegistry([...DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES]),
  });
  const invocationId = "turn-0/root";
  const attach = {
    sessionId: options.sessionId ?? `driver-cancellation-session:${options.driverKind}`,
    taskId: invocationId,
    program: {
      id: cancellationManifest.programId,
      version: cancellationManifest.version,
      digest: cancellationManifest.digest,
    },
    input: "hello",
    route: options.route ?? { driverKind: options.driverKind },
    executionEpoch: 1,
  };
  yield* authority.openTask({
    sessionId: attach.sessionId,
    turnId: "turn-0",
    taskId: attach.taskId,
    manifest: cancellationManifest,
    input: attach.input,
    executionEpoch: attach.executionEpoch,
    attachmentId: "unattached",
    audience: "fixture-program",
  });

  const first = yield* ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
      });
    });
  });
  if (first.state !== "parked") {
    throw new Error(`Expected cancellation fixture to park, received ${first.state}`);
  }
  const pending = findPendingElicit(authority.readJournal(attach.sessionId));
  const attachmentWasProcessless = activeAttachments === 0 && shutdownCount === 1;
  yield* authority.requestCancellation(
    attach.sessionId,
    attach.taskId,
    "integration-test-cancellation",
    "cancel-command-1",
  );

  authority = createInMemoryDurableJournalAuthority({
    journalId: `driver-cancellation-integration:${options.driverKind}`,
    journalIncarnation: "fixture-1",
    keyring,
    snapshot: authority.exportSnapshot(),
    schemaRegistry: createDurableSchemaRegistry([...DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES]),
  });
  const second = yield* ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
      });
    });
  });
  if (second.state !== "cancelled") {
    throw new Error(`Expected recovered cancellation, received ${second.state}`);
  }

  const semanticJournal = authority.readJournal(attach.sessionId);
  return {
    firstRun: first,
    secondRun: second,
    invocationId,
    pendingPullId: pending.payload.pullId,
    normalizedJournal: semanticJournal.map((record) => record.payload.type),
    semanticJournal,
    attachmentWasProcessless,
    attachmentCount,
    shutdownCount,
    effectExecutions,
    cleanupExecutions,
    cancellationCatches: semanticJournal.filter(
      (record) =>
        record.payload.type === "DurableEmission" &&
        record.payload.descriptor.eventType === "cancellation_caught",
    ).length,
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
