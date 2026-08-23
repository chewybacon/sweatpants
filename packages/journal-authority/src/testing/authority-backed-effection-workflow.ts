/**
 * Quarantined proof surface for the authority-backed Effection Workflow
 * vertical. The implementation now lives in `../workflow/runtime.ts` under
 * promoted names; these aliases keep the vertical's tests, typecheck
 * fixtures, and evidence reproducible until cutover completes.
 */
export type {
  CoordinatedRecordAttempt,
  DurableProgramEffect,
  ProgramAttachmentHandle as ProofProgramAttachmentHandle,
  ProgramCommand as ProofProgramCommand,
  ProgramEffectRuntime,
  ProgramEvent as ProofProgramEvent,
  RecordAttemptContract,
  RuntimeRecordBoundary,
  SerializableProgramProposal,
  Workflow,
} from "../workflow/runtime.ts";
export {
  ProgramEffectRuntimeContext,
  RecordAttemptPort,
  ephemeral,
  openProgramAttachment as openProofProgramAttachment,
  programCommandParser as proofProgramCommandParser,
  programShutdownReasonParser as proofShutdownReasonParser,
  record,
  recordWorkflowOptionsParser,
} from "../workflow/runtime.ts";

export {
  driveActivation as runProofRecordWorkflow,
  hostAuthority as proofHostAuthority,
} from "../workflow/host-drive.ts";
