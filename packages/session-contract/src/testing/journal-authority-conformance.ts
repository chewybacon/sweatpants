import { all, type Operation } from "effection";

import { canonicalJson } from "../canonical.ts";
import { createCapabilityKeyring, type CapabilityKeyring } from "../capabilities.ts";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
  type DurableSchemaRegistryEntry,
} from "../schema-registry.ts";
import { CrankError } from "../types.ts";
import {
  anyGuard,
  booleanGuard,
  createSchemaFixture,
  nullGuard,
  stringGuard,
} from "./schema-fixtures.ts";
import type {
  CancellationAcknowledgement,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  DurableProgramManifest,
} from "../durable-types.ts";
import type {
  DurableSemanticRecord,
  InMemoryDurableJournalAuthority,
  OpenDurableTaskRequest,
} from "../durable-authority.ts";

/**
 * Operation-native authority surface exercised identically by every durable
 * journal backend. Read methods are operations so process-local and remote
 * stores cross one testing boundary without leaking storage mechanics.
 */
export interface JournalAuthorityConformancePort {
  /** Clears a runnable marker at the start of a structured activation. */
  markActivationStarted(sessionId: string): Operation<void>;
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
export const JOURNAL_AUTHORITY_CONFORMANCE_SCHEMA_ENTRIES: readonly DurableSchemaRegistryEntry[] =
  Object.freeze([
    conformanceProgramInput.entry,
    conformanceProgramOutput.entry,
    conformanceApprovalResponse.entry,
    conformanceEchoInput.entry,
    conformanceEchoOutput.entry,
    conformanceMutateInput.entry,
    conformanceMutateOutput.entry,
  ]);

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
      retrySafety: { mode: "unsafe", onIndeterminate: "await_decision" },
    },
    fail_mutate: {
      name: "fail_mutate",
      version: "1",
      inputSchema: conformanceMutateInput.descriptor,
      outputSchema: conformanceMutateOutput.descriptor,
      retrySafety: { mode: "unsafe", onIndeterminate: "fail" },
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
export function adaptInMemoryAuthorityForConformance(
  authority: InMemoryDurableJournalAuthority,
): JournalAuthorityConformancePort {
  return {
    *markActivationStarted(selectedSessionId) {
      yield* authority.markActivationStarted(selectedSessionId);
    },
    *openTask(request) {
      return yield* authority.openTask(request);
    },
    *reserve(request) {
      return yield* authority.reserve(request);
    },
    *resolve(request) {
      return yield* authority.resolve(request);
    },
    *replaceAttachment(selectedSessionId, selectedTaskId, attachmentId, audience) {
      return yield* authority.replaceAttachment(
        selectedSessionId,
        selectedTaskId,
        attachmentId,
        audience,
      );
    },
    *requestCancellation(selectedSessionId, selectedTaskId, reason, commandId) {
      return yield* authority.requestCancellation(
        selectedSessionId,
        selectedTaskId,
        reason,
        commandId,
      );
    },
    *forceOrphan(selectedSessionId, selectedTaskId, reason) {
      yield* authority.forceOrphan(selectedSessionId, selectedTaskId, reason);
    },
    *abandonAttempt(selectedSessionId, selectedTaskId, pullId, attemptId, reason) {
      yield* authority.abandonAttempt(selectedSessionId, selectedTaskId, pullId, attemptId, reason);
    },
    *readJournal(selectedSessionId) {
      return authority.readJournal(selectedSessionId);
    },
    *runnableSessions() {
      return authority.runnableSessions();
    },
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
  ];
}

function defineCase(
  factory: JournalAuthorityConformanceFactory,
  name: string,
  scenario: (
    caseName: string,
    open: () => Operation<JournalAuthorityConformancePort>,
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
      yield* scenario(caseName, () =>
        factory.open({
          journalId,
          keyring,
          schemaRegistry: createDurableSchemaRegistry([
            ...JOURNAL_AUTHORITY_CONFORMANCE_SCHEMA_ENTRIES,
          ]),
        }),
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
  yield* independent.markActivationStarted(sessionId);
  assert(
    caseName,
    !(yield* independent.runnableSessions()).includes(sessionId),
    "activation must consume the runnable marker",
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
    parked.status === "pending" && parked.reason === "indeterminate",
    "unsafe detached work must remain indeterminate",
  );
  requireAccepted(
    caseName,
    yield* authority.resolve({
      capability: first.resolutionCapability,
      audience: "mutator",
      outcome: { status: "ok", value: { committed: true } },
    }),
  );
  const replay = yield* authority.reserve(
    effectRequest(replacement.programCapability, "mutate", "mutator"),
  );
  assert(caseName, replay.status === "resolved", "new owner must replay the old resolver outcome");
  assertTypes(caseName, yield* authority.readJournal(sessionId), [
    "TaskOpened",
    "PullRequested",
    "AttemptStarted",
    "AttemptDetached",
    "PullIndeterminate",
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
  assertEqual(
    caseName,
    yield* authority.resolve({
      capability: second.resolutionCapability,
      audience: "host-effects",
      outcome: { status: "ok", value: "different" },
    }),
    { status: "rejected", code: "idempotency_conflict" },
    "different competing outcome must report idempotency conflict",
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
    audience: "program-runtime",
  };
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
