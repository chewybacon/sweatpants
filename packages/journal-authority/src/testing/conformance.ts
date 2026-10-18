import type { SchemaBinding } from "@sweatpants/foundation/schema";
import { CrankError } from "@sweatpants/durable-execution";
import { all, type Operation } from "effection";

import { canonicalJson } from "@sweatpants/foundation";
import { createCapabilityKeyring, type CapabilityKeyring } from "../contract/capabilities.ts";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "../contract/schema-registry.ts";

import {
  anyGuard,
  booleanGuard,
  createSchemaFixture,
  nullGuard,
  stringGuard,
} from "./schema-fixtures.ts";
import type {
  BindRestoreFrontierRequest,
  BindRestoreFrontierResult,
  ConsumeRestoreTicketRequest,
  ConsumeRestoreTicketResult,
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  ClaimActivationRequest,
  ClaimActivationResult,
  RenewActivationRequest,
  RenewActivationResult,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  PrepareProgramRestoreRequest,
} from "../contract/authority-types.ts";
import type {
  CancellationAcknowledgement,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  DurableOperationState,
  DurableTaskRecoveryState,
  OpenDurableTaskRequest,
} from "../contract/authority-types.ts";
import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import type {
  AuthorityCommand,
  AuthorityJournalContract,
  CommandResult,
  JournalAuthorityContract,
} from "../contract/authority-contract.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";

/**
 * Operation-native authority surface exercised identically by every durable
 * journal backend. Read methods are operations so process-local and remote
 * stores cross one testing boundary without leaking storage mechanics.
 */
export interface JournalAuthorityConformancePort {
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  taskExecutionState(
    sessionId: string,
    taskId: string,
  ): Operation<import("../contract/authority-types.ts").DurableTaskExecutionState>;
  taskInput(sessionId: string, taskId: string): Operation<import("@sweatpants/foundation").Json>;
  nonterminalSchemaDigests(): Operation<readonly string[]>;
  recoverableSessions(): Operation<
    readonly import("../contract/authority-types.ts").RecoverableSession[]
  >;
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ readonly programCapability: string }>;
  cancellationState(
    sessionId: string,
    taskId: string,
  ): Operation<import("../contract/authority-types.ts").DurableCancellationState>;
  beginCancellationUnwind(
    sessionId: string,
    taskId: string,
    restoredFrontier?: {
      readonly proof: import("../contract/authority-types.ts").RestoredFrontierProof;
      readonly step: import("@sweatpants/durable-execution").ProgramStep;
    },
  ): Operation<import("../contract/authority-types.ts").DurableCancellationState>;
  prepareProgramRestore(
    request: PrepareProgramRestoreRequest,
  ): Operation<import("../contract/authority-types.ts").PreparedProgramRestore>;
  emit(
    request: import("../contract/authority-types.ts").AppendEmissionRequest,
  ): Operation<import("../contract/authority-types.ts").EmissionReceipt>;
  complete(
    request: import("../contract/authority-types.ts").CompleteTaskRequest,
  ): Operation<import("../contract/authority-types.ts").CompleteTaskResult>;
  ensureChildTask(
    request: import("../contract/authority-types.ts").EnsureChildTaskRequest,
  ): Operation<import("../contract/authority-types.ts").EnsureChildTaskResult>;
  /** Selects active root work or its terminal value without exposing the journal. */
  taskRecoveryState(
    sessionId: string,
    requestedTaskId?: string,
  ): Operation<DurableTaskRecoveryState>;
  rootTaskCount(sessionId: string): Operation<number>;
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
  /** Clears a runnable marker at the start of a structured activation. */
  /** Claims absent/expired runnable work under an authority-minted epoch. */
  claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult>;
  /** Renews only the exact current owner and epoch using authority time. */
  renewActivation(request: RenewActivationRequest): Operation<RenewActivationResult>;
  /** Releases exact ownership and re-derives runnable state. */
  releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult>;
  /** Issues a host-private single-use ticket for one authority snapshot. */
  issueRestoreTicket(request: IssueRestoreTicketRequest): Operation<IssueRestoreTicketResult>;
  /** Binds the host-verified remote frontier digest without consuming the ticket. */
  bindRestoreFrontier(request: BindRestoreFrontierRequest): Operation<BindRestoreFrontierResult>;
  /** Atomically verifies and consumes one first-live-frontier ticket. */
  consumeRestoreTicket(request: ConsumeRestoreTicketRequest): Operation<ConsumeRestoreTicketResult>;
  /** Opens one exact pinned task and returns its attachment-bound program capability. */
  openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
  /** Reserves or replays one action through the production authority boundary. */
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  /** Resolves one existing pull through its audience-bound capability. */
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  /** Replaces the current program attachment and fences its old program capability. */
  replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    audience?: string,
  ): Operation<{ executionEpoch: number; programCapability: string }>;
  /** Records one idempotent logical cancellation command. */
  requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): Operation<CancellationAcknowledgement>;
  /** Administratively orphans work without claiming graceful cleanup. */
  forceOrphan(
    sessionId: string,
    taskId: string,
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged",
  ): Operation<void>;
  /** Revokes one attempt while preserving its pull and competing attempts. */
  abandonAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    attemptId: string,
    reason?: string,
  ): Operation<void>;
  /** Reads a parsed defensive semantic journal projection. */
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  /** Reads deterministic runnable session identities. */
  runnableSessions(): Operation<string[]>;
}

/**
 * Backend factory used by the shared conformance corpus. Reopening the same
 * journal ID MUST create an independent handle over the same durable state.
 */
export interface JournalAuthorityConformanceFactory {
  /** Stable safe backend label used only in test diagnostics and journal IDs. */
  readonly backendName: string;
  /** Opens a handle over the durable state identified by `journalId`. */
  open(options: {
    journalId: string;
    keyring: CapabilityKeyring;
    schemaRegistry: DurableSchemaRegistry;
    /**
     * Authority clock. Lease expiry is a storage-semantics behaviour, so it can
     * only be certified when a case controls time rather than pinning it.
     */
    now: () => number;
  }): Operation<JournalAuthorityConformancePort>;
}

/** One backend-neutral conformance case executable as an Effection operation. */
export interface JournalAuthorityConformanceCase {
  /** Caller-visible invariant represented by this case. */
  readonly name: string;
  /** Runs the invariant against the configured production backend seam. */
  run(): Operation<void>;
}

/** Stable defect raised only when a backend violates the shared authority contract. */
export class JournalAuthorityConformanceError extends Error {
  readonly _tag = "JournalAuthorityConformanceError" as const;
  readonly caseName: string;
  readonly detail: string;

  /** Creates a safe diagnostic defect without serializing journal payloads. */
  constructor(caseName: string, detail: string) {
    super(`JournalAuthority conformance failed in ${caseName}: ${detail}`);
    this.name = "JournalAuthorityConformanceError";
    this.caseName = caseName;
    this.detail = detail;
  }
}

const conformanceProgramInput = createSchemaFixture(
  "conformance.authority/input",
  "program_input",
  { type: "null" },
  nullGuard,
);
const conformanceProgramOutput = createSchemaFixture(
  "conformance.authority/output",
  "program_output",
  true,
  anyGuard,
);
const conformanceApprovalResponse = createSchemaFixture(
  "conformance.authority/approval-response",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);
const conformanceEchoInput = createSchemaFixture(
  "conformance.authority/echo-input",
  "effect_input",
  { type: "string" },
  stringGuard,
);
const conformanceEchoOutput = createSchemaFixture(
  "conformance.authority/echo-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const conformanceMutateInput = createSchemaFixture(
  "conformance.authority/mutate-input",
  "effect_input",
  true,
  anyGuard,
);
const conformanceMutateOutput = createSchemaFixture(
  "conformance.authority/mutate-output",
  "effect_output",
  true,
  anyGuard,
);

/** Registry entries required by every backend running the conformance corpus. */
export const JOURNAL_AUTHORITY_CONFORMANCE_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze(
  [
    conformanceProgramInput.entry,
    conformanceProgramOutput.entry,
    conformanceApprovalResponse.entry,
    conformanceEchoInput.entry,
    conformanceEchoOutput.entry,
    conformanceMutateInput.entry,
    conformanceMutateOutput.entry,
  ],
);

const idempotentManifest: DurableProgramManifest = {
  programId: "conformance.authority",
  version: "1.0.0",
  digest: "c".repeat(64),
  inputSchema: conformanceProgramInput.descriptor,
  outputSchema: conformanceProgramOutput.descriptor,
  elicits: { approval: { response: conformanceApprovalResponse.descriptor } },
  effects: {
    echo: {
      name: "echo",
      version: "1",
      inputSchema: conformanceEchoInput.descriptor,
      outputSchema: conformanceEchoOutput.descriptor,
      retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
    },
    mutate: {
      name: "mutate",
      version: "1",
      inputSchema: conformanceMutateInput.descriptor,
      outputSchema: conformanceMutateOutput.descriptor,
      retrySafety: { mode: "unsafe" },
    },
    fail_mutate: {
      name: "fail_mutate",
      version: "1",
      inputSchema: conformanceMutateInput.descriptor,
      outputSchema: conformanceMutateOutput.descriptor,
      retrySafety: { mode: "unsafe" },
    },
  },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

const sessionId = "authority-conformance-session";
const taskId = "turn-0/root";
const turnId = "turn-0";

/**
 * Adapts the synchronous diagnostic reads of the process-local authority to the
 * operation-native conformance port. Mutations retain the production methods.
 */
export function adaptAuthorityPortsForConformance(
  authority: JournalAuthorityContract,
  journal: AuthorityJournalContract,
  identity: { readonly id: string; readonly incarnation: string },
): JournalAuthorityConformancePort {
  function command<C extends AuthorityCommand>(selected: C): Operation<CommandResult<C>> {
    return authority.command(selected);
  }
  return {
    journalIdentity: () => identity,
    taskExecutionState: (sessionId, taskId) =>
      authority.query({ type: "task.execution-state", sessionId, taskId }),
    taskInput: (sessionId, taskId) => authority.query({ type: "task.input", sessionId, taskId }),
    nonterminalSchemaDigests: () =>
      authority.query({ type: "authority.nonterminal-schema-digests" }),
    recoverableSessions: () => authority.query({ type: "authority.recoverable-sessions" }),
    bindProgramAttachment: (sessionId, taskId, attachmentId, executionEpoch) =>
      command({
        type: "execution.bind-attachment",
        request: { sessionId, taskId, attachmentId, executionEpoch },
      }) as never,
    cancellationState: (sessionId, taskId) =>
      authority.query({ type: "task.cancellation-state", sessionId, taskId }),
    beginCancellationUnwind: (sessionId, taskId, restoredFrontier) =>
      command({
        type: "execution.begin-cancellation-unwind",
        request: {
          sessionId,
          taskId /* CONDITIONAL-SPREAD: Omit absent restoredFrontier from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */,
          ...(restoredFrontier ? { restoredFrontier } : {}),
        },
      }) as never,
    prepareProgramRestore: (request) =>
      command({ type: "recovery.prepare-restore", request }) as never,
    emit: (request) => command({ type: "execution.append-emission", request }) as never,
    complete: (request) => command({ type: "execution.complete-task", request }) as never,
    ensureChildTask: (request) => command({ type: "execution.ensure-child", request }) as never,
    taskRecoveryState: (sessionId, taskId) =>
      authority.query({
        type: "task.recovery-state",
        sessionId /* CONDITIONAL-SPREAD: Omit absent taskId from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */,
        ...(taskId ? { taskId } : {}),
      }),
    rootTaskCount: (sessionId) => authority.query({ type: "session.root-task-count", sessionId }),
    operationState: (sessionId, taskId, pullId) =>
      authority.query({ type: "pull.state", sessionId, taskId, pullId }),
    claimActivation: (request) => command({ type: "control.claim-activation", request }) as never,
    renewActivation: (request) => command({ type: "control.renew-activation", request }) as never,
    releaseActivation: (request) =>
      command({ type: "control.release-activation", request }) as never,
    issueRestoreTicket: (request) => command({ type: "recovery.issue-ticket", request }) as never,
    bindRestoreFrontier: (request) => command({ type: "recovery.bind-frontier", request }) as never,
    consumeRestoreTicket: (request) =>
      command({ type: "recovery.consume-ticket", request }) as never,
    openTask: (request) => command({ type: "execution.open-task", request }) as never,
    reserve: (request) => command({ type: "execution.reserve-pull", request }) as never,
    resolve: (request) => command({ type: "execution.resolve-pull", request }) as never,
    replaceAttachment: (sessionId, taskId, attachmentId, audience) =>
      command({
        type: "execution.replace-attachment",
        request: {
          sessionId,
          taskId,
          attachmentId /* CONDITIONAL-SPREAD: Omit absent audience from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */,
          ...(audience ? { audience } : {}),
        },
      }) as never,
    requestCancellation: (sessionId, taskId, reason, commandId) =>
      command({
        type: "execution.request-cancellation",
        request: {
          sessionId,
          taskId,
          /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(reason !== undefined ? { reason } : {}),
          /* CONDITIONAL-SPREAD: Omit absent commandId from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(commandId !== undefined ? { commandId } : {}),
        },
      }) as never,
    forceOrphan: (sessionId, taskId, reason) =>
      command({ type: "execution.force-orphan", request: { sessionId, taskId, reason } }) as never,
    abandonAttempt: (sessionId, taskId, pullId, attemptId, reason) =>
      command({
        type: "execution.abandon-attempt",
        request: {
          sessionId,
          taskId,
          pullId,
          attemptId,
          /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(reason !== undefined ? { reason } : {}),
        },
      }) as never,
    readJournal: (sessionId) =>
      journal.readSession(sessionId) as Operation<DurableSemanticRecord[]>,
    runnableSessions: () =>
      authority.query({ type: "authority.runnable-sessions" }) as Operation<string[]>,
  };
}

/**
 * Builds the exact shared conformance corpus for one backend. Each case owns a
 * unique journal and observes only public authority results and durable records.
 */
export function createJournalAuthorityConformanceCases(
  factory: JournalAuthorityConformanceFactory,
): readonly JournalAuthorityConformanceCase[] {
  return [
    defineCase(factory, "reserve, processless resolve, and idempotent receipts", atomicResolution),
    defineCase(
      factory,
      "owner takeover accepts detached completion and fences old program",
      takeover,
    ),
    defineCase(factory, "attempt detachment and abandonment remain distinct", attemptStates),
    defineCase(
      factory,
      "fail-on-indeterminate settles a replayable coded outcome",
      failOnIndeterminate,
    ),
    defineCase(factory, "competing outcomes converge atomically", competingOutcomes),
    defineCase(factory, "cancellation and resolution preserve journal ordering", cancellationRace),
    defineCase(
      factory,
      "duplicate cancellation preserves first reason and frontier",
      duplicateCancellation,
    ),
    defineCase(
      factory,
      "pending elicitation cancels directly and revokes response",
      directElicitCancellation,
    ),
    defineCase(factory, "force orphan revokes work without clean cancellation", forceOrphan),
    defineCase(factory, "recovery selects active work without exposing the journal", recoveryQuery),
    defineCase(factory, "activation lease fences a competing owner", activationLeaseFencing),
    defineCase(
      factory,
      "expired activation lease is reclaimed under a new epoch",
      activationLeaseExpiry,
    ),
    defineCase(factory, "stale epoch cannot renew or release an activation", staleActivationEpoch),
    defineCase(factory, "structured child allocation is deterministic", structuredChildAllocation),
    defineCase(factory, "emission and completion close one bounded task", emissionAndCompletion),
    defineCase(factory, "cancellation state enters one-shot unwind", cancellationStateUnwind),
    defineCase(factory, "restore ticket is consumable exactly once", restoreTicketSingleUse),
    defineCase(
      factory,
      "restore ticket does not survive activation takeover",
      restoreTicketAfterTakeover,
    ),
  ];
}

function defineCase(
  factory: JournalAuthorityConformanceFactory,
  name: string,
  scenario: (
    caseName: string,
    open: () => Operation<JournalAuthorityConformancePort>,
    clock: { advance: (ms: number) => void },
  ) => Operation<void>,
): JournalAuthorityConformanceCase {
  const caseName = `${factory.backendName}: ${name}`;
  const keyring = createCapabilityKeyring(`authority-conformance:${factory.backendName}`, [
    { keyId: "active", secret: "authority-conformance-secret-key" },
  ]);
  const journalId = `authority-conformance:${factory.backendName}:${slug(name)}`;
  return {
    name,
    *run() {
      // Shared mutable clock: every handle opened by a case observes the same
      // authority time, so a lease expiring for one owner expires for all.
      let currentMs = 1_000;
      const clock = {
        advance: (ms: number) => {
          currentMs += ms;
        },
      };
      yield* scenario(
        caseName,
        () =>
          factory.open({
            journalId,
            keyring,
            schemaRegistry: createDurableSchemaRegistry([
              ...JOURNAL_AUTHORITY_CONFORMANCE_SCHEMA_ENTRIES,
            ]),
            now: () => currentMs,
          }),
        clock,
      );
    },
  };
}

function* atomicResolution(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const first = yield* open();
  const programCapability = yield* openRoot(first);
  const reserved = requireAuthorized(
    caseName,
    yield* first.reserve(effectRequest(programCapability, "echo", "host-effects")),
  );
  assertTypes(caseName, yield* first.readJournal(sessionId), [
    "TaskOpened",
    "PullRequested",
    "AttemptStarted",
  ]);

  const independent = yield* open();
  yield* independent.openTask({
    ...rootRequest("turn-1/root", "turn-1", "sibling-attachment"),
    executionEpoch: 1,
  });
  assertEqual(
    caseName,
    yield* independent.resolve({
      capability: reserved.resolutionCapability,
      audience: "wrong-audience",
      outcome: { status: "ok", value: "hello" },
    }),
    { status: "rejected", code: "wrong_audience" },
    "wrong audience must be rejected as a value",
  );

  const accepted = requireAccepted(
    caseName,
    yield* independent.resolve({
      capability: reserved.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "hello" },
    }),
  );
  assert(
    caseName,
    (yield* independent.runnableSessions()).includes(sessionId),
    "ownerless resolution must mark the session runnable",
  );
  const duplicate = requireDuplicate(
    caseName,
    yield* first.resolve({
      capability: reserved.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "hello" },
    }),
  );
  assertEqual(
    caseName,
    duplicate.receipt.resolutionOffset,
    accepted.receipt.resolutionOffset,
    "duplicate must return the original resolution offset",
  );
  assertEqual(
    caseName,
    duplicate.receipt.outcomeDigest,
    accepted.receipt.outcomeDigest,
    "duplicate must return the original outcome digest",
  );
  assertEqual(
    caseName,
    yield* independent.resolve({
      capability: reserved.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "different" },
    }),
    { status: "rejected", code: "resolution_conflict" },
    "different duplicate must not overwrite the first outcome",
  );

  const replay = yield* first.reserve(effectRequest(programCapability, "echo", "host-effects"));
  assert(
    caseName,
    replay.status === "resolved" &&
      replay.outcome.status === "ok" &&
      replay.outcome.value === "hello",
    "the original handle must replay the independently committed outcome",
  );
}

function* takeover(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const oldProgramCapability = yield* openRoot(authority);
  const first = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(oldProgramCapability, "mutate", "mutator")),
  );
  const replacement = yield* authority.replaceAttachment(
    sessionId,
    taskId,
    "replacement-attachment",
  );

  const staleCode = yield* captureCrankCode(function* () {
    yield* authority.reserve(effectRequest(oldProgramCapability, "mutate", "mutator"));
  });
  assertEqual(
    caseName,
    staleCode,
    "stale_program_capability",
    "takeover must fence the old program capability",
  );

  const parked = yield* authority.reserve(
    effectRequest(replacement.programCapability, "mutate", "mutator"),
  );
  assert(
    caseName,
    parked.status === "resolved" &&
      parked.outcome.status === "error" &&
      parked.outcome.error.code === "effect_outcome_indeterminate",
    "detaching an unsafe attempt must settle it as a coded indeterminate outcome",
  );
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: first.resolutionCapability,
      audience: "mutator",
      outcome: { status: "ok", value: { committed: true } },
    }),
    { status: "rejected", code: "capability_revoked" },
    "the detached resolver must be fenced once the outcome is settled",
  );
  assertTypes(caseName, yield* authority.readJournal(sessionId), [
    "TaskOpened",
    "PullRequested",
    "AttemptStarted",
    "AttemptDetached",
    "PullIndeterminate",
    "AttemptAbandoned",
    "PullResolved",
  ]);
}

function* failOnIndeterminate(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const oldProgramCapability = yield* openRoot(authority);
  const first = requireAuthorized(
    caseName,
    yield* authority.reserve(
      effectRequest(oldProgramCapability, "fail_mutate", "fail-closed-mutator"),
    ),
  );
  const replacement = yield* authority.replaceAttachment(
    sessionId,
    taskId,
    "replacement-attachment",
  );

  const replay = yield* authority.reserve(
    effectRequest(replacement.programCapability, "fail_mutate", "fail-closed-mutator"),
  );
  assert(
    caseName,
    replay.status === "resolved" &&
      replay.outcome.status === "error" &&
      replay.outcome.error.code === "effect_outcome_indeterminate",
    "fail policy must settle the detached pull as a coded replayable error",
  );
  assert(
    caseName,
    (yield* authority.runnableSessions()).includes(sessionId),
    "fail policy must make the session runnable",
  );
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: first.resolutionCapability,
      audience: "fail-closed-mutator",
      outcome: { status: "ok", value: { committed: true } },
    }),
    { status: "rejected", code: "capability_revoked" },
    "late detached resolution must be revoked after fail-closed settlement",
  );
  assertTypes(caseName, yield* authority.readJournal(sessionId), [
    "TaskOpened",
    "PullRequested",
    "AttemptStarted",
    "AttemptDetached",
    "PullIndeterminate",
    "AttemptAbandoned",
    "PullResolved",
  ]);
}

function* attemptStates(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const oldProgramCapability = yield* openRoot(authority);
  const first = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(oldProgramCapability, "echo", "host-effects")),
  );
  const replacement = yield* authority.replaceAttachment(
    sessionId,
    taskId,
    "replacement-attachment",
  );
  const second = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(replacement.programCapability, "echo", "host-effects")),
  );
  assert(
    caseName,
    first.pullId === second.pullId && first.attemptId !== second.attemptId,
    "reauthorization must preserve pull identity and allocate a new attempt",
  );

  yield* authority.abandonAttempt(
    sessionId,
    taskId,
    first.pullId,
    first.attemptId,
    "operator-revoked",
  );
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: first.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "late" },
    }),
    { status: "rejected", code: "capability_revoked" },
    "abandoned attempt capability must not redeem",
  );
  requireAccepted(
    caseName,
    yield* authority.resolve({
      capability: second.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "winner" },
    }),
  );
  const types = (yield* authority.readJournal(sessionId)).map((record) => record.payload.type);
  assert(caseName, types.includes("AttemptDetached"), "takeover must record detachment");
  assert(caseName, types.includes("AttemptAbandoned"), "revocation must record abandonment");
}

function* competingOutcomes(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const oldProgramCapability = yield* openRoot(authority);
  const first = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(oldProgramCapability, "echo", "host-effects")),
  );
  const replacement = yield* authority.replaceAttachment(
    sessionId,
    taskId,
    "replacement-attachment",
  );
  const second = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(replacement.programCapability, "echo", "host-effects")),
  );

  const equalResults = yield* all([
    authority.resolve({
      capability: first.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "same" },
    }),
    authority.resolve({
      capability: second.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "same" },
    }),
  ]);
  assert(
    caseName,
    equalResults.filter((result) => result.status === "accepted").length === 1 &&
      equalResults.filter((result) => result.status === "duplicate").length === 1,
    "equal competing outcomes must converge",
  );
  // Concurrent completion order is unspecified. The duplicate identifies the
  // superseded attempt; array position does not determine who won the race.
  const loser = equalResults[0].status === "duplicate" ? first : second;
  const winner = equalResults[0].status === "accepted" ? first : second;
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: loser.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "different" },
    }),
    { status: "rejected", code: "idempotency_conflict" },
    "different competing outcome must report idempotency conflict",
  );
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: winner.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "different" },
    }),
    { status: "rejected", code: "resolution_conflict" },
    "different outcome from the winning attempt must report resolution conflict",
  );
  const records = yield* authority.readJournal(sessionId);
  assert(
    caseName,
    records.filter((record) => record.payload.type === "PullResolved").length === 1,
    "competing outcomes must append exactly one resolution",
  );
  assert(
    caseName,
    records.some((record) => record.payload.type === "AttemptSuperseded"),
    "winner must supersede its competitor",
  );

  const unequalSessionId = `${sessionId}-unequal`;
  const unequalTaskId = `${taskId}-unequal`;
  const unequalAuthority = yield* open();
  const unequalOldProgram = yield* openRoot(unequalAuthority, unequalSessionId, unequalTaskId);
  const unequalFirst = requireAuthorized(
    caseName,
    yield* unequalAuthority.reserve(
      effectRequest(unequalOldProgram, "echo", "host-effects", unequalSessionId, unequalTaskId),
    ),
  );
  const unequalReplacement = yield* unequalAuthority.replaceAttachment(
    unequalSessionId,
    unequalTaskId,
    "unequal-replacement-attachment",
  );
  const unequalSecond = requireAuthorized(
    caseName,
    yield* unequalAuthority.reserve(
      effectRequest(
        unequalReplacement.programCapability,
        "echo",
        "host-effects",
        unequalSessionId,
        unequalTaskId,
      ),
    ),
  );
  const unequalResults = yield* all([
    unequalAuthority.resolve({
      capability: unequalFirst.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "left" },
    }),
    unequalAuthority.resolve({
      capability: unequalSecond.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "right" },
    }),
  ]);
  assert(
    caseName,
    unequalResults.filter((result) => result.status === "accepted").length === 1 &&
      unequalResults.filter(
        (result) => result.status === "rejected" && result.code === "idempotency_conflict",
      ).length === 1,
    "unequal competing outcomes must preserve one winner and reject the other",
  );
  assert(
    caseName,
    (yield* unequalAuthority.readJournal(unequalSessionId)).filter(
      (record) => record.payload.type === "PullResolved",
    ).length === 1,
    "unequal competing outcomes must append exactly one resolution",
  );
}

function* cancellationRace(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const cancellationFirst = yield* open();
  const firstProgramCapability = yield* openRoot(cancellationFirst);
  const pending = requireAuthorized(
    caseName,
    yield* cancellationFirst.reserve(effectRequest(firstProgramCapability, "echo", "host-effects")),
  );
  yield* cancellationFirst.requestCancellation(sessionId, taskId, "user-requested");
  assertEqual(
    caseName,
    yield* cancellationFirst.resolve({
      capability: pending.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "late" },
    }),
    { status: "rejected", code: "capability_revoked" },
    "non-settleable cancellation must revoke a late completion",
  );
  assertTypes(caseName, yield* cancellationFirst.readJournal(sessionId), [
    "TaskOpened",
    "PullRequested",
    "AttemptStarted",
    "CancellationRequested",
    "AttemptOutcomeUnknown",
    "PullResolved",
  ]);

  const secondSessionId = `${sessionId}-resolution-first`;
  const resolutionFirst = yield* open();
  const secondProgramCapability = yield* openRoot(
    resolutionFirst,
    secondSessionId,
    `${taskId}-resolution-first`,
  );
  const resolvedFirst = requireAuthorized(
    caseName,
    yield* resolutionFirst.reserve(
      effectRequest(
        secondProgramCapability,
        "echo",
        "host-effects",
        secondSessionId,
        `${taskId}-resolution-first`,
      ),
    ),
  );
  const accepted = requireAccepted(
    caseName,
    yield* resolutionFirst.resolve({
      capability: resolvedFirst.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "committed" },
    }),
  );
  yield* resolutionFirst.requestCancellation(
    secondSessionId,
    `${taskId}-resolution-first`,
    "user-requested",
  );
  const duplicate = requireDuplicate(
    caseName,
    yield* resolutionFirst.resolve({
      capability: resolvedFirst.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "committed" },
    }),
  );
  assertEqual(
    caseName,
    duplicate.receipt.resolutionOffset,
    accepted.receipt.resolutionOffset,
    "resolution-first must preserve the committed outcome",
  );
  assertTypes(caseName, yield* resolutionFirst.readJournal(secondSessionId), [
    "TaskOpened",
    "PullRequested",
    "AttemptStarted",
    "PullResolved",
    "CancellationRequested",
  ]);
}

function* duplicateCancellation(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  yield* openRoot(authority);
  const first = yield* authority.requestCancellation(
    sessionId,
    taskId,
    "first reason",
    "cancel-command-1",
  );
  const duplicate = yield* authority.requestCancellation(
    sessionId,
    taskId,
    "different reason",
    "cancel-command-2",
  );
  assert(caseName, first.duplicate === false, "first cancellation must not be a duplicate");
  assert(caseName, duplicate.duplicate === true, "second cancellation must be idempotent");
  assertEqual(caseName, duplicate.commandId, first.commandId, "first command identity must win");
  assertEqual(caseName, duplicate.reason, "first reason", "first reason must win");
  assertEqual(caseName, duplicate.frontier, first.frontier, "first frontier must win");
  assert(
    caseName,
    (yield* authority.readJournal(sessionId)).filter(
      (record) => record.payload.type === "CancellationRequested",
    ).length === 1,
    "duplicate cancellation must append one semantic command",
  );
  assert(
    caseName,
    (yield* authority.runnableSessions()).includes(sessionId),
    "cancellation must mark ownerless work runnable",
  );
}

function* directElicitCancellation(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const programCapability = yield* openRoot(authority);
  const pending = yield* authority.reserve({
    sessionId,
    turnId,
    taskId,
    actionIndex: 0,
    pullIndex: 0,
    descriptor: {
      kind: "elicit",
      key: "approval",
      message: "Approve?",
      response: conformanceApprovalResponse.descriptor,
    },
    programCapability,
  });
  if (pending.status !== "pending" || !pending.resolutionCapability) {
    throw new JournalAuthorityConformanceError(caseName, "elicitation did not park");
  }
  yield* authority.requestCancellation(sessionId, taskId, "stop", "cancel-elicit");
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: pending.resolutionCapability,
      audience: "user:approval",
      outcome: { status: "ok", value: true },
    }),
    { status: "rejected", code: "capability_revoked" },
    "late elicitation response must be revoked",
  );
  assertTypes(caseName, yield* authority.readJournal(sessionId), [
    "TaskOpened",
    "PullRequested",
    "CancellationRequested",
    "PullResolved",
  ]);
}

function* forceOrphan(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const programCapability = yield* openRoot(authority);
  const pending = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(programCapability, "echo", "host-effects")),
  );
  yield* authority.forceOrphan(sessionId, taskId, "cleanup_stuck");
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: pending.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "late" },
    }),
    { status: "rejected", code: "capability_revoked" },
    "force orphan must revoke unresolved work",
  );
  const types = (yield* authority.readJournal(sessionId)).map((record) => record.payload.type);
  assert(caseName, types.includes("CleanupSkipped"), "force orphan must record skipped cleanup");
  assert(
    caseName,
    types.includes("TaskOrphaned"),
    "force orphan must record orphan terminal state",
  );
  assert(caseName, !types.includes("TaskClosed"), "force orphan must not claim clean cancellation");
}

function rootRequest(
  selectedTaskId = taskId,
  selectedTurnId = turnId,
  attachmentId = "initial-attachment",
  selectedSessionId = sessionId,
): OpenDurableTaskRequest {
  return {
    sessionId: selectedSessionId,
    turnId: selectedTurnId,
    taskId: selectedTaskId,
    manifest: idempotentManifest,
    input: null,
    executionEpoch: 1,
    attachmentId,
    audience: "workflow-host",
  };
}

/** Authority-owned recovery returns enough accepted state to resume one root. */
function* recoveryQuery(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  let programCapability = yield* openRoot(authority);
  assert(caseName, authority.journalIdentity().id.length > 0, "journal identity must be stable");
  assertEqual(caseName, yield* authority.rootTaskCount(sessionId), 1, "root count must be exact");
  assertEqual(caseName, yield* authority.taskInput(sessionId, taskId), null, "input must be exact");
  assertEqual(
    caseName,
    yield* authority.taskExecutionState(sessionId, taskId),
    { executionEpoch: 1 },
    "execution state must expose the accepted epoch",
  );
  const schemaDigests = yield* authority.nonterminalSchemaDigests();
  assert(
    caseName,
    schemaDigests.includes(idempotentManifest.inputSchema.digest) &&
      schemaDigests.includes(idempotentManifest.outputSchema.digest),
    "nonterminal schemas must include the pinned input and output",
  );
  assert(
    caseName,
    (yield* authority.recoverableSessions()).some((entry) => entry.sessionId === sessionId),
    "opened root must make its Session recoverable",
  );

  programCapability = (yield* authority.bindProgramAttachment(
    sessionId,
    taskId,
    "recovery-query",
    1,
  )).programCapability;
  const reserved = requireAuthorized(
    caseName,
    yield* authority.reserve(effectRequest(programCapability, "echo", "host-effects")),
  );
  const operation = yield* authority.operationState(sessionId, taskId, reserved.pullId);
  assert(caseName, operation.status === "found", "reserved operation must be queryable");
  if (operation.status === "found") {
    assertEqual(caseName, operation.audience, "host-effects", "query must preserve audience");
    assert(caseName, operation.outcome === undefined, "pending operation must have no outcome");
  }

  const recovery = yield* authority.taskRecoveryState(sessionId);
  assert(caseName, recovery.status === "active", "new root task must be recoverable");
  if (recovery.status !== "active") {
    return;
  }
  assertEqual(caseName, recovery.taskId, taskId, "recovery must select the root task");
  assertEqual(caseName, recovery.input, null, "recovery must return canonical accepted input");
  assertEqual(
    caseName,
    recovery.activeTasks,
    [{ taskId, executionEpoch: 1, attachmentId: "recovery-query" }],
    "recovery must return the exact active tree fence",
  );
}

/**
 * A held activation lease must exclude every other owner.
 *
 * This is the property that makes one crank turner safe (ADR-001): if two hosts
 * could hold the same Session, both would drive the same journal.
 */
function* activationLeaseFencing(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const first = yield* open();
  yield* openRoot(first);

  const claimed = yield* first.claimActivation({
    sessionId,
    ownerId: "owner-a",
    leaseDurationMs: 30_000,
  });
  assert(caseName, claimed.status === "claimed", "first owner must claim a runnable session");

  // A second host, unaware of the first, must be refused rather than given a
  // second lease. `busy` also has to carry usable backoff.
  const competitor = yield* open();
  const competing = yield* competitor.claimActivation({
    sessionId,
    ownerId: "owner-b",
    leaseDurationMs: 30_000,
  });
  assert(caseName, competing.status === "busy", "a held lease must refuse a competing owner");
  assert(
    caseName,
    competing.status === "busy" && competing.retryAfterMs > 0,
    "a busy claim must report positive backoff",
  );
}

/**
 * An expired lease must be reclaimable, and the new activation must carry a
 * strictly greater epoch so fenced writes from the dead owner stay rejected.
 */
function* activationLeaseExpiry(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
  clock: { advance: (ms: number) => void },
): Operation<void> {
  const first = yield* open();
  yield* openRoot(first);

  const claimed = yield* first.claimActivation({
    sessionId,
    ownerId: "owner-a",
    leaseDurationMs: 30_000,
  });
  assert(caseName, claimed.status === "claimed", "first owner must claim");
  const firstEpoch = claimed.status === "claimed" ? claimed.epoch : -1;

  // Host death is indistinguishable from silence, so recovery depends entirely
  // on the lease elapsing in authority time.
  clock.advance(30_001);

  const replacement = yield* open();
  const reclaimed = yield* replacement.claimActivation({
    sessionId,
    ownerId: "owner-b",
    leaseDurationMs: 30_000,
  });
  assert(caseName, reclaimed.status === "claimed", "an expired lease must be reclaimable");
  assert(
    caseName,
    reclaimed.status === "claimed" && reclaimed.epoch > firstEpoch,
    "a reclaimed activation must mint a strictly greater epoch",
  );
}

/**
 * Renewal and release must be exact in both owner and epoch, so a host that
 * lost its lease cannot extend or retire an activation it no longer owns.
 */
function* staleActivationEpoch(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
  clock: { advance: (ms: number) => void },
): Operation<void> {
  const first = yield* open();
  yield* openRoot(first);
  const claimed = yield* first.claimActivation({
    sessionId,
    ownerId: "owner-a",
    leaseDurationMs: 30_000,
  });
  assert(caseName, claimed.status === "claimed", "first owner must claim");
  const epoch = claimed.status === "claimed" ? claimed.epoch : -1;

  assertEqual(
    caseName,
    yield* first.renewActivation({ sessionId, ownerId: "owner-b", epoch }),
    { status: "stale_activation" },
    "a different owner must not renew a lease",
  );
  assertEqual(
    caseName,
    yield* first.renewActivation({ sessionId, ownerId: "owner-a", epoch: epoch + 1 }),
    { status: "stale_activation" },
    "a future epoch must not renew a lease",
  );

  clock.advance(30_001);
  const replacement = yield* open();
  const reclaimed = yield* replacement.claimActivation({
    sessionId,
    ownerId: "owner-b",
    leaseDurationMs: 30_000,
  });
  assert(caseName, reclaimed.status === "claimed", "expired lease must be reclaimable");

  // The dead owner now tries to retire the activation the new owner holds.
  assertEqual(
    caseName,
    yield* first.releaseActivation({
      sessionId,
      ownerId: "owner-a",
      epoch,
      reason: "scope_exit",
    }),
    { status: "stale_activation" },
    "a superseded owner must not release the current activation",
  );
}

/** Child allocation is deterministic and remains inside the root recovery tree. */
function* structuredChildAllocation(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const programCapability = yield* openRoot(authority);
  const child = {
    id: "conformance.child",
    version: "1.0.0",
    digest: "d".repeat(64),
    input: null,
  };
  const reserved = yield* authority.reserve({
    sessionId,
    turnId,
    taskId,
    actionIndex: 0,
    pullIndex: 0,
    descriptor: { kind: "invoke", child },
    programCapability,
  });
  assert(caseName, reserved.status === "pending", "invoke must park for its child");
  if (reserved.status !== "pending") {
    return;
  }
  const request = {
    sessionId,
    turnId,
    parentTaskId: taskId,
    parentPullId: reserved.pullId,
    child,
    manifest: {
      ...idempotentManifest,
      programId: child.id,
      version: child.version,
      digest: child.digest,
    },
    executionEpoch: 1,
    audience: "workflow-host",
  };
  const allocated = yield* authority.ensureChildTask(request);
  assertEqual(
    caseName,
    yield* authority.ensureChildTask(request),
    allocated,
    "duplicate child allocation must return the same identity",
  );
  const recovery = yield* authority.taskRecoveryState(sessionId, allocated.taskId);
  assert(
    caseName,
    recovery.status === "active" && recovery.taskId === taskId,
    "requesting an active child must recover its root",
  );
}

/** Emission ordering and terminal closure are identical across stores. */
function* emissionAndCompletion(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const programCapability = yield* openRoot(authority);
  const emission = yield* authority.emit({
    sessionId,
    taskId,
    actionIndex: 0,
    descriptor: { eventType: "progress", payload: { ordinal: 1 } },
    programCapability,
  });
  assert(caseName, !emission.duplicate, "first emission must append");

  const closeRequest = {
    sessionId,
    taskId,
    actionIndex: 1,
    outcome: { status: "ok" as const, value: "done" },
    programCapability,
  };
  const closed = yield* authority.complete(closeRequest);
  assert(
    caseName,
    closed.status === "accepted" && !closed.receipt.duplicate,
    "first completion must close",
  );
  const replayed = yield* authority.complete(closeRequest);
  assert(
    caseName,
    replayed.status === "duplicate" && replayed.receipt.duplicate,
    "identical completion must be idempotent",
  );
  assertEqual(
    caseName,
    yield* authority.taskRecoveryState(sessionId),
    { status: "terminal", taskId, outcome: closeRequest.outcome },
    "closed root must recover as its terminal value",
  );
}

/** Cancellation is queryable and authored unwind begins exactly once. */
function* cancellationStateUnwind(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  yield* openRoot(authority);
  yield* authority.requestCancellation(sessionId, taskId, "operator", "cancel-command");

  const requested = yield* authority.cancellationState(sessionId, taskId);
  assert(caseName, requested.type === "requested", "cancellation must be durably requested");
  const unwinding = yield* authority.beginCancellationUnwind(sessionId, taskId);
  assert(caseName, unwinding.type === "unwinding", "requested cancellation must begin unwind");
  assertEqual(
    caseName,
    yield* authority.beginCancellationUnwind(sessionId, taskId),
    unwinding,
    "duplicate unwind must return the first state",
  );
}

/** A frontier digest is 32 bytes of hex; content is irrelevant to the authority. */
const frontierDigest = "a".repeat(64);

/** Claims an activation and opens the root task, returning the minted epoch. */
function* activateRoot(
  caseName: string,
  authority: JournalAuthorityConformancePort,
  ownerId: string,
): Operation<number> {
  yield* openRoot(authority);
  const claimed = yield* authority.claimActivation({
    sessionId,
    ownerId,
    leaseDurationMs: 30_000,
  });
  assert(caseName, claimed.status === "claimed", `${ownerId} must claim a runnable session`);
  return claimed.status === "claimed" ? claimed.epoch : -1;
}

/**
 * A restore ticket must be redeemable once and only once.
 *
 * Single-use is what stops two hosts from both believing they restored the same
 * frontier. In memory that is a map delete; in Redis it is a cross-command
 * atomicity question, which is exactly the kind of difference a storage rewrite
 * can lose silently.
 */
function* restoreTicketSingleUse(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
): Operation<void> {
  const authority = yield* open();
  const epoch = yield* activateRoot(caseName, authority, "owner-a");

  const prepared = yield* authority.prepareProgramRestore({
    sessionId,
    taskId,
    ownerId: "owner-a",
    activationEpoch: epoch,
    releaseId: "conformance-release",
    sandboxSessionId: "conformance-sandbox",
    replayDomain: "sweatpants.conformance.replay.v1",
    frontierDomain: "sweatpants.conformance.frontier.v1",
  });
  assertEqual(caseName, prepared.replay, [], "new task must prepare an empty replay");

  const issued = yield* authority.issueRestoreTicket({
    sessionId,
    taskId,
    ownerId: "owner-a",
    activationEpoch: epoch,
    replayedThroughActionIndex: 0,
    replayChainDigest: frontierDigest,
  });

  const bound = yield* authority.bindRestoreFrontier({
    sessionId,
    taskId,
    ownerId: "owner-a",
    activationEpoch: epoch,
    restoreTicket: issued.restoreTicket,
    frontierDigest,
  });
  assert(caseName, bound.status === "bound", "a fresh ticket must bind its frontier");
  const proof = bound.status === "bound" ? bound.proof : undefined;
  assert(caseName, proof !== undefined, "binding must yield a proof");

  const consumeRequest: ConsumeRestoreTicketRequest = {
    sessionId,
    taskId,
    ownerId: "owner-a",
    activationEpoch: epoch,
    proof: proof as ConsumeRestoreTicketRequest["proof"],
  };

  assertEqual(
    caseName,
    yield* authority.consumeRestoreTicket(consumeRequest),
    { status: "consumed" },
    "the first consumption must succeed",
  );

  const replayed = yield* authority.consumeRestoreTicket(consumeRequest);
  assert(
    caseName,
    replayed.status === "restore_stale",
    "replaying a consumed ticket must be refused",
  );
}

/**
 * A ticket minted under one activation must be worthless after takeover, even
 * though it is still cryptographically valid.
 */
function* restoreTicketAfterTakeover(
  caseName: string,
  open: () => Operation<JournalAuthorityConformancePort>,
  clock: { advance: (ms: number) => void },
): Operation<void> {
  const authority = yield* open();
  const epoch = yield* activateRoot(caseName, authority, "owner-a");

  const issued = yield* authority.issueRestoreTicket({
    sessionId,
    taskId,
    ownerId: "owner-a",
    activationEpoch: epoch,
    replayedThroughActionIndex: 0,
    replayChainDigest: frontierDigest,
  });

  // owner-a dies; its lease lapses and owner-b takes the Session.
  clock.advance(30_001);
  const successor = yield* open();
  const reclaimed = yield* successor.claimActivation({
    sessionId,
    ownerId: "owner-b",
    leaseDurationMs: 30_000,
  });
  assert(caseName, reclaimed.status === "claimed", "successor must reclaim the expired lease");

  assertEqual(
    caseName,
    yield* successor.bindRestoreFrontier({
      sessionId,
      taskId,
      ownerId: "owner-a",
      activationEpoch: epoch,
      restoreTicket: issued.restoreTicket,
      frontierDigest,
    }),
    { status: "restore_stale" },
    "a ticket from a superseded activation must not bind",
  );
}

function* openRoot(
  authority: JournalAuthorityConformancePort,
  selectedSessionId = sessionId,
  selectedTaskId = taskId,
): Operation<string> {
  const opened = yield* authority.openTask(
    rootRequest(selectedTaskId, turnId, "initial-attachment", selectedSessionId),
  );
  return opened.programCapability;
}

function effectRequest(
  programCapability: string,
  name: "echo" | "mutate" | "fail_mutate",
  audience: string,
  selectedSessionId = sessionId,
  selectedTaskId = taskId,
): ReserveOperationRequest {
  return {
    sessionId: selectedSessionId,
    turnId,
    taskId: selectedTaskId,
    actionIndex: 0,
    pullIndex: 0,
    descriptor: {
      kind: "effect",
      name,
      version: "1",
      input: name === "echo" ? "hello" : null,
      resolver: { audience },
    },
    programCapability,
  };
}

function requireAuthorized(
  caseName: string,
  result: ReserveOperationResult,
): Extract<ReserveOperationResult, { status: "authorized" }> {
  if (result.status !== "authorized") {
    throw new JournalAuthorityConformanceError(
      caseName,
      `expected authorization, received ${result.status}`,
    );
  }
  return result;
}

function requireAccepted(
  caseName: string,
  result: ResolveOperationResult,
): Extract<ResolveOperationResult, { status: "accepted" | "duplicate" }> {
  if (result.status !== "accepted") {
    throw new JournalAuthorityConformanceError(
      caseName,
      `expected accepted resolution, received ${canonicalJson(result)}`,
    );
  }
  return result;
}

function requireDuplicate(
  caseName: string,
  result: ResolveOperationResult,
): Extract<ResolveOperationResult, { status: "accepted" | "duplicate" }> {
  if (result.status !== "duplicate") {
    throw new JournalAuthorityConformanceError(
      caseName,
      `expected duplicate resolution, received ${canonicalJson(result)}`,
    );
  }
  return result;
}

function assertTypes(
  caseName: string,
  records: readonly DurableSemanticRecord[],
  expected: readonly DurableSemanticRecord["payload"]["type"][],
): void {
  assertEqual(
    caseName,
    records.map((record) => record.payload.type),
    expected,
    "semantic record order differs",
  );
}

function assertEqual(caseName: string, actual: unknown, expected: unknown, detail: string): void {
  assert(caseName, canonicalJson(actual) === canonicalJson(expected), detail);
}

function assert(caseName: string, condition: boolean, detail: string): asserts condition {
  if (!condition) {
    throw new JournalAuthorityConformanceError(caseName, detail);
  }
}

function* captureCrankCode(operation: () => Operation<void>): Operation<string | undefined> {
  try {
    yield* operation();
    return undefined;
  } catch (error) {
    if (error instanceof CrankError) {
      return error.code;
    }
    throw error;
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
