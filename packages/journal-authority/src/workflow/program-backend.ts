import type { Operation } from "effection";
import {
  CrankError,
  exactProgramKey,
  REPLAY_CHECKPOINT_CAPABILITIES,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type DurableToolRegistry,
  type PinnedProgram,
  type ProgramCheckpoint,
  type ProgramDriverCapabilities,
} from "@sweatpants/durable-execution";
import type { Work } from "@sweatpants/foundation/computation";
import type { Json } from "@sweatpants/foundation";
import type { ProgramExecutionState } from "./program-execution.ts";
import { durableToolWorkflow } from "./tool-adapter.ts";

/** One computation, suspended through the shared attachment's effect runtime. */
export interface ProgramComputation {
  start(): Operation<ProgramExecutionState>;
  /** Captures computation only; the attachment owns protocol position and receipts. */
  capture(): Operation<ProgramCheckpoint>;
  dispose(): Operation<void>;
}

/** Native scheduling capability; cursor implementers keep ProgramComputation unchanged. */
export interface NativeWorkComputation {
  readonly work: Work<
    Json,
    ReturnType<Operation<Json>[typeof Symbol.iterator]> extends Iterator<infer Y> ? Y : never
  >;
  capture(): Operation<ProgramCheckpoint>;
  dispose(): Operation<void>;
}

export type BackendComputation = ProgramComputation | NativeWorkComputation;

/**
 * Executes pinned code without owning program routing or the attachment protocol.
 * open is resource-owned: its compute is released when the attachment scope ends.
 * A restored computation's start returns its saved boundary before advancing.
 */
export interface ProgramBackend<C extends BackendComputation = ProgramComputation> {
  readonly capabilities: ProgramDriverCapabilities;
  manifest(program: PinnedProgram): Operation<DurableProgramManifest>;
  open(
    request: AttachProgramRequest,
    checkpoint?: Extract<ProgramCheckpoint, { kind: "continuation" }>,
  ): Operation<C>;
}

/** Ordinary developer generators; execution state is reconstructed by replay. */
export function createEffectionProgramBackend(
  tools: DurableToolRegistry,
): ProgramBackend<NativeWorkComputation> {
  function toolFor(program: PinnedProgram) {
    const tool = tools.get(exactProgramKey(program));
    if (!tool) {
      throw new CrankError(
        "program_version_unavailable",
        `No exact program bundle for ${exactProgramKey(program)}`,
      );
    }
    return tool;
  }
  return {
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    *manifest(program) {
      return toolFor(program).manifest;
    },
    *open(request, checkpoint) {
      if (checkpoint) {
        throw new CrankError("program_protocol_error", "Effection backend requires replay");
      }
      return {
        work: function* () {
          return yield* durableToolWorkflow(toolFor(request.program), request.input)();
        },
        *capture() {
          return { kind: "replay" };
        },
        *dispose() {},
      };
    },
  };
}
