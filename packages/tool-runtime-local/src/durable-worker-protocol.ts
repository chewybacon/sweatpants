import type {
  AttachProgramRequest,
  ProgramAttachment,
  ProgramCommand,
  ProgramShutdownReason,
  ProgramStep,
} from "@sweatpants/session-contract";

/** Serializable attachment metadata; the evaluator handle remains worker-local. */
export type DurableWorkerAttachmentMetadata = Omit<ProgramAttachment, "handle">;

/** Host-to-worker command protocol for one isolated program attachment. */
export type DurableProgramWorkerRequest =
  | { type: "attach"; request: AttachProgramRequest }
  | { type: "step"; command: ProgramCommand }
  | { type: "shutdown"; reason: ProgramShutdownReason };

/** Safe worker-side defect projection. Arbitrary thrown values never cross the boundary. */
export type DurableProgramWorkerError = {
  code: string;
  message: string;
};

/** Worker-to-host response protocol for one isolated program attachment. */
export type DurableProgramWorkerResponse =
  | { type: "attached"; attachment: DurableWorkerAttachmentMetadata }
  | { type: "step"; step: ProgramStep }
  | { type: "shutdown_complete" }
  | { type: "rejected"; error: DurableProgramWorkerError };

/** Terminal worker result used only for transport diagnostics. */
export type DurableProgramWorkerResult = { type: "closed" };
