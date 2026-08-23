/**
 * Public-surface snapshot (TC-206 / REQ-002).
 *
 * Every imported name below must exist for this file to compile, so removals
 * or renames fail `pnpm check` during phases 1-3. Additions are permitted and
 * extend these lists deliberately at phase boundaries.
 */
import type { Json } from "@sweatpants/foundation";
import {
  InstalledEffectPort,
  ProgramEffectRuntimeContext,
  RecordAttemptPort,
  elicit,
  elicitOptionsParser,
  effect,
  installedEffect,
  invoke,
  invokeOptionsParser,
  effectOptionsParser,
  emit,
  ephemeral,
  openProgramAttachment,
  programCommandParser,
  programShutdownReasonParser,
  record,
  recordWorkflowOptionsParser,
  wait,
  waitOptionsParser,
  type CoordinatedRecordAttempt,
  type Durable,
  type DurableProgramEffect,
  type InstalledEffectContract,
  type ProgramAttachmentHandle,
  type ProgramCommand,
  type ProgramEffectRuntime,
  type ProgramEvent,
  type RecordAttemptContract,
  type RuntimeRecordBoundary,
  type SerializableProgramProposal,
  type Workflow,
} from "./runtime.ts";
import { driveActivation } from "./host-drive.ts";
import {
  openProofProgramAttachment,
  proofProgramCommandParser,
  proofShutdownReasonParser,
  record as proofRecord,
  recordWorkflowOptionsParser as proofRecordWorkflowOptionsParser,
  runProofRecordWorkflow,
  type ProofProgramAttachmentHandle,
  type ProofProgramCommand,
  type ProofProgramEvent,
} from "../testing/authority-backed-effection-workflow.ts";

/** Promoted production surface: values must stay callable, types must stay resolvable. */
export interface RuntimeSurfaceSnapshot {
  authoring: [
    typeof record,
    typeof installedEffect,
    typeof effect,
    typeof wait,
    typeof elicit,
    typeof invoke,
    typeof emit,
    typeof ephemeral,
  ];
  parsers: [
    typeof recordWorkflowOptionsParser,
    typeof effectOptionsParser,
    typeof waitOptionsParser,
    typeof elicitOptionsParser,
    typeof invokeOptionsParser,
    typeof programCommandParser,
    typeof programShutdownReasonParser,
  ];
  context: typeof ProgramEffectRuntimeContext;
  coordination: typeof RecordAttemptPort;
  installedEffects: typeof InstalledEffectPort;
  attachment: typeof openProgramAttachment;
  driver: typeof driveActivation;
  command: ProgramCommand;
  event: ProgramEvent;
  handle: ProgramAttachmentHandle;
  workflow: Workflow<Json>;
  programEffect: DurableProgramEffect<unknown>;
  runtime: ProgramEffectRuntime;
  boundary: RuntimeRecordBoundary<Json>;
  coordinated: CoordinatedRecordAttempt;
  contract: RecordAttemptContract;
  installedEffectContract: InstalledEffectContract;
  proposal: SerializableProgramProposal;
  /** The authoring envelope making settled values infer at call sites. */
  handle2: Durable<Json>;
}

/** Quarantined proof aliases must keep resolving until cutover completes. */
export interface ProofSurfaceSnapshot {
  values: [
    typeof proofRecord,
    typeof proofRecordWorkflowOptionsParser,
    typeof openProofProgramAttachment,
    typeof runProofRecordWorkflow,
    typeof proofProgramCommandParser,
    typeof proofShutdownReasonParser,
  ];
  command: ProofProgramCommand;
  event: ProofProgramEvent;
  handle: ProofProgramAttachmentHandle;
}

/**
 * Inference probe (REQ-004 companion): the settled value of a delegated
 * boundary must infer its payload type without any authoring-side cast.
 */
function* inferenceProbe(): Workflow<string> {
  const one = yield* record({ key: "probe" }, function* () {
    return "value";
  });
  const checked: string = one;
  return `${checked}!`;
}
void inferenceProbe;

export const publicSurfaceSnapshot: {
  runtime: RuntimeSurfaceSnapshot;
  proof: ProofSurfaceSnapshot;
} = {
  runtime: {
    authoring: [record, installedEffect, effect, wait, elicit, invoke, emit, ephemeral],
    parsers: [
      recordWorkflowOptionsParser,
      effectOptionsParser,
      waitOptionsParser,
      elicitOptionsParser,
      invokeOptionsParser,
      programCommandParser,
      programShutdownReasonParser,
    ],
    context: ProgramEffectRuntimeContext,
    coordination: RecordAttemptPort,
    installedEffects: InstalledEffectPort,
    attachment: openProgramAttachment,
    driver: driveActivation,
    command: { type: "cancel", reason: "snapshot" },
    event: { type: "completed", actionIndex: 0, value: null },
    handle: {} as never,
    workflow: undefined as never,
    programEffect: undefined as never,
    runtime: undefined as never,
    boundary: undefined as never,
    coordinated: undefined as never,
    contract: undefined as never,
    installedEffectContract: undefined as never,
    proposal: { type: "operation", descriptor: undefined as never },
    handle2: undefined as never as Durable<Json>,
  },
  proof: {
    values: [
      proofRecord,
      proofRecordWorkflowOptionsParser,
      openProofProgramAttachment,
      runProofRecordWorkflow,
      proofProgramCommandParser,
      proofShutdownReasonParser,
    ],
    command: { type: "cancel", reason: "snapshot" },
    event: { type: "completed", actionIndex: 0, value: null },
    handle: {} as never,
  },
};
