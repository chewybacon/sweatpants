import { createContext, type Operation } from "effection";

import {
  assertSchemaValue,
  createDurableProgramContext,
  serializeDurableError,
} from "./authoring.ts";
import { canonicalSnapshot, stableOpaqueId } from "./canonical.ts";
import { CrankError, type Json } from "./types.ts";
import type {
  AttachProgramRequest,
  DurableProgramGenerator,
  DurableProgramManifest,
  DurableTool,
  OperationOutcome,
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramShutdownReason,
  ProgramStep,
  ProgramStepProposal,
} from "./durable-types.ts";

export type DurableToolRegistry = ReadonlyMap<string, DurableTool>;
export type ProgramDriverRegistry = ReadonlyMap<string, ProgramDriver>;

export const DurableToolRegistryContext = createContext<DurableToolRegistry | undefined>(
  "session-contract:durable-tool-registry",
  undefined,
);
export const ProgramDriverRegistryContext = createContext<ProgramDriverRegistry | undefined>(
  "session-contract:program-driver-registry",
  undefined,
);

export function createDurableToolRegistry(tools: Iterable<DurableTool>): DurableToolRegistry {
  const registry = new Map<string, DurableTool>();
  for (const tool of tools) {
    const key = programKey(tool.manifest.programId, tool.manifest.version, tool.manifest.digest);
    if (registry.has(key)) {
      throw new CrankError("invalid_manifest", `Duplicate durable program ${key}`);
    }
    registry.set(key, tool);
  }
  return registry;
}

export function createProgramDriverRegistry(
  drivers: Iterable<readonly [string, ProgramDriver]>,
): ProgramDriverRegistry {
  return new Map(drivers);
}

export function* useDurableToolRegistry(): Operation<DurableToolRegistry> {
  const registry = yield* DurableToolRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No durable tool registry is installed");
  }
  return registry;
}

export function* useProgramDriverRegistry(): Operation<ProgramDriverRegistry> {
  const registry = yield* ProgramDriverRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No program driver registry is installed");
  }
  return registry;
}

type GeneratorState = {
  request: AttachProgramRequest;
  tool: DurableTool;
  generator?: DurableProgramGenerator;
  pending?: ProgramStepProposal;
  actionIndex: number;
  started: boolean;
  terminal: boolean;
  shutdown: boolean;
};

class RuntimeAttachmentHandle {
  constructor(readonly state: GeneratorState) {}
  toJSON(): never {
    throw new CrankError("invalid_descriptor", "Program attachments are runtime-only");
  }
}

export function createLocalGeneratorDriver(registry?: DurableToolRegistry): ProgramDriver {
  return {
    *attach(request: AttachProgramRequest): Operation<ProgramAttachment> {
      const tools = registry ?? (yield* useDurableToolRegistry());
      const key = programKey(request.program.id, request.program.version, request.program.digest);
      const tool = tools.get(key);
      if (!tool) {
        throw new CrankError("program_version_unavailable", `No exact program bundle for ${key}`);
      }
      const input = assertSchemaValue(
        tool.manifest.inputSchema,
        request.input,
        "invalid_descriptor",
      );
      const canonicalRoute = canonicalSnapshot(request.route).value;
      const attachmentId = nextProgramAttachmentId(request);
      const state: GeneratorState = {
        request: { ...request, input, route: canonicalRoute },
        tool,
        actionIndex: 0,
        started: false,
        terminal: false,
        shutdown: false,
      };
      return {
        attachmentId,
        taskId: request.taskId,
        driverKind: "generator",
        route: canonicalRoute,
        executionEpoch: request.executionEpoch,
        handle: new RuntimeAttachmentHandle(state),
      };
    },

    *step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep> {
      const state = attachmentState(attachment);
      assertLiveAttachment(attachment, state);
      if (state.terminal) {
        throw new CrankError("task_terminal", "Program attachment is terminal");
      }
      if (command.type === "start") {
        if (state.started) {
          throw protocol("start repeated");
        }
        const input = assertSchemaValue(
          state.tool.manifest.inputSchema,
          command.input,
          "invalid_descriptor",
        );
        if (canonicalSnapshot(input).sha !== canonicalSnapshot(state.request.input).sha) {
          throw protocol("start input mismatch");
        }
        state.started = true;
        try {
          const generator = state.tool.program(input, createDurableProgramContext());
          if (!generator || typeof generator.next !== "function") {
            throw new CrankError("invalid_manifest", "Program factory did not return a generator");
          }
          state.generator = generator;
          return advance(state, () => generator.next());
        } catch (error) {
          return fail(state, error);
        }
      }
      if (!state.started || !state.generator || !state.pending) {
        throw protocol("command before a pending action");
      }
      const generator = state.generator;
      if (command.type === "authorize") {
        if (command.actionIndex !== state.actionIndex) {
          throw protocol("authorization action index mismatch");
        }
        if (state.pending.type !== "operation" || state.pending.descriptor.kind !== "effect") {
          throw protocol("authorization for non-effect action");
        }
        // Authorization does not resume a pure generator. Remote drivers may execute
        // the effect here; the local host executes through DurableEffects.
        return proposalStep(state.pending, state.actionIndex);
      }
      if (command.type === "resume") {
        if (command.actionIndex !== state.actionIndex || state.pending.type !== "operation") {
          throw protocol("resume action mismatch");
        }
        const outcome = canonicalOutcome(command.outcome);
        state.actionIndex += 1;
        return advance(state, () => generator.next(outcome));
      }
      if (command.type === "ack_emission") {
        if (command.actionIndex !== state.actionIndex || state.pending.type !== "emission") {
          throw protocol("emission acknowledgement mismatch");
        }
        state.actionIndex += 1;
        return advance(state, () => generator.next(undefined));
      }
      if (command.type === "cancel") {
        try {
          state.actionIndex += 1;
          // Generator.return requires the declared successful return type, but
          // structured cancellation intentionally supplies no successful value.
          return advance(state, () => generator.return(undefined as never));
        } catch (error) {
          return fail(state, error);
        }
      }
      throw protocol("unknown program command");
    },

    *shutdown(attachment: ProgramAttachment, _reason: ProgramShutdownReason): Operation<void> {
      const state = attachmentState(attachment);
      if (state.shutdown) {
        return;
      }
      state.shutdown = true;
      // Parking and transport loss dispose the frame without injecting logical
      // cancellation. Cancellation must be sent explicitly and driven through
      // all yielded finally operations before shutdown.
      delete state.generator;
      delete state.pending;
    },

    *manifest(program): Operation<DurableProgramManifest> {
      const tools = registry ?? (yield* useDurableToolRegistry());
      const tool = tools.get(programKey(program.id, program.version, program.digest));
      if (!tool) {
        throw new CrankError(
          "program_version_unavailable",
          `No exact program bundle for ${program.id}@${program.version}#${program.digest}`,
        );
      }
      return tool.manifest;
    },
  };
}

function advance(
  state: GeneratorState,
  next: () => IteratorResult<ProgramStepProposal, Json>,
): ProgramStep {
  try {
    const result = next();
    if (result.done) {
      delete state.pending;
      state.terminal = true;
      const value = assertSchemaValue(
        state.tool.manifest.outputSchema,
        result.value,
        "schema_validation_failed",
      );
      return { type: "completed", actionIndex: state.actionIndex, value };
    }
    validateProposal(result.value);
    state.pending = structuredClone(result.value);
    return proposalStep(state.pending, state.actionIndex);
  } catch (error) {
    return fail(state, error);
  }
}

function proposalStep(proposal: ProgramStepProposal, actionIndex: number): ProgramStep {
  return proposal.type === "operation"
    ? { type: "operation", actionIndex, descriptor: structuredClone(proposal.descriptor) }
    : { type: "emission", actionIndex, descriptor: structuredClone(proposal.descriptor) };
}

function fail(state: GeneratorState, error: unknown): ProgramStep {
  delete state.pending;
  state.terminal = true;
  return { type: "failed", actionIndex: state.actionIndex, error: serializeDurableError(error) };
}

function canonicalOutcome(outcome: OperationOutcome): OperationOutcome {
  const value = canonicalSnapshot(outcome).value;
  if (!value || !["ok", "error", "cancelled"].includes(value.status)) {
    throw protocol("invalid outcome");
  }
  return value;
}

function validateProposal(proposal: ProgramStepProposal): void {
  if (
    !proposal ||
    typeof proposal !== "object" ||
    !["operation", "emission"].includes(proposal.type)
  ) {
    throw protocol("invalid program proposal");
  }
  canonicalSnapshot(proposal);
}

function attachmentState(attachment: ProgramAttachment): GeneratorState {
  if (!(attachment.handle instanceof RuntimeAttachmentHandle)) {
    throw protocol("foreign or serialized attachment");
  }
  return attachment.handle.state;
}

function assertLiveAttachment(attachment: ProgramAttachment, state: GeneratorState): void {
  if (state.shutdown) {
    throw new CrankError("stale_program_capability", "Attachment is shut down");
  }
  if (
    attachment.taskId !== state.request.taskId ||
    attachment.executionEpoch !== state.request.executionEpoch
  ) {
    throw new CrankError("stale_program_capability");
  }
}

function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}

function programKey(id: string, version: string, digest: string): string {
  return `${id}@${version}#${digest}`;
}

export function stableProgramAttachmentId(request: AttachProgramRequest): string {
  return stableOpaqueId("attachment-seed", [
    request.sessionId,
    request.taskId,
    request.executionEpoch,
    request.program.id,
    request.program.version,
    request.program.digest,
  ]);
}

let attachmentCounter = 0;
function nextProgramAttachmentId(request: AttachProgramRequest): string {
  attachmentCounter += 1;
  return stableOpaqueId("attachment", [
    request.sessionId,
    request.taskId,
    request.executionEpoch,
    request.program.id,
    request.program.version,
    request.program.digest,
    attachmentCounter,
  ]);
}
