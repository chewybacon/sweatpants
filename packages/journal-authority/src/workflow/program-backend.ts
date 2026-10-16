import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
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
import { durableToolWorkflow } from "./tool-adapter.ts";

/** One computation, suspended through the shared attachment's effect runtime. */
export interface ProgramComputation {
  run(): Operation<Json>;
  /** Captures computation only; the attachment owns protocol position and receipts. */
  capture(): Operation<ProgramCheckpoint>;
  dispose(): Operation<void>;
}

/**
 * Executes pinned code without owning program routing or the attachment protocol.
 * open is resource-owned: its compute is released when the attachment scope ends.
 * A restored computation's run publishes its saved boundary before advancing.
 */
export interface ProgramBackend {
  readonly capabilities: ProgramDriverCapabilities;
  manifest(program: PinnedProgram): Operation<DurableProgramManifest>;
  open(
    request: AttachProgramRequest,
    checkpoint?: Extract<ProgramCheckpoint, { kind: "continuation" }>,
  ): Operation<ProgramComputation>;
}

/** Ordinary developer generators; execution state is reconstructed by replay. */
export function createEffectionProgramBackend(tools: DurableToolRegistry): ProgramBackend {
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
        run: durableToolWorkflow(toolFor(request.program), request.input),
        *capture() {
          return { kind: "replay" };
        },
        *dispose() {},
      };
    },
  };
}
