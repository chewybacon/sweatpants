import { CrankError } from "./errors.ts";
import {
  createQueue,
  createScope,
  useAbortSignal,
  useScope,
  withResolvers,
  type Operation,
  type Queue,
  type Scope,
} from "effection";

import {
  assertInlineSize,
  assertReplayedCanonicalValue,
  createDurableProgramContext,
  serializeDurableError,
  DurableProgramCancellation,
} from "./program-context.ts";
import { canonicalSnapshot, stableOpaqueId, type Json } from "@sweatpants/foundation";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import type { DurableEffectRegistry } from "@sweatpants/durable-effects/authoring";
import { validateProgramIdentityProvenance } from "./program-identity.ts";
import type {
  DurableProgramContext,
  DurableTool,
  ProgramResume,
  ProgramStepProposal,
} from "./program-authoring.ts";
import type {
  DurableChildDescriptor,
  DurableProgramManifest,
  ForeignToolRequest,
  PinnedProgram,
} from "./program-contract.ts";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type {
  AttachProgramRequest,
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramShutdownReason,
  ProgramStep,
} from "./program-driver-contract.ts";
import { REPLAY_CHECKPOINT_CAPABILITIES } from "./program-driver-contract.ts";
import {
  ExecutionDurableEffectRegistryContext,
  ProgramExecutionScopeContext,
  useDurableToolRegistry,
  type DurableToolRegistry,
} from "./program-runtime-context.ts";
import {
  ProgramExecutionContext,
  createProgramExecutionValue,
  type ProgramExecutionValue,
} from "./program-execution-context.ts";

/** Builds a registry and rejects duplicate program IDs. */
export function createDurableToolRegistry(
  tools: Iterable<DurableTool<any, any>>,
): DurableToolRegistry {
  const registry = new Map<string, DurableTool<any, any>>();
  for (const tool of tools) {
    validateProgramIdentityProvenance(tool);
    const key = exactProgramKey({
      id: tool.manifest.programId,
      version: tool.manifest.version,
      digest: tool.manifest.digest,
    });
    if (registry.has(key)) {
      throw new CrankError("invalid_manifest", `Duplicate durable program ${key}`);
    }
    registry.set(key, tool);
  }
  return registry;
}

type RuntimeBoundary = {
  proposal: ProgramStepProposal;
  resume: {
    operation: Operation<ProgramResume>;
    resolve(value: ProgramResume): void;
    reject(error: Error): void;
  };
};

type RuntimeEvent =
  | { type: "proposal"; boundary: RuntimeBoundary }
  | { type: "completed"; value: Json }
  | { type: "failed"; error: ReturnType<typeof serializeDurableError> };

type ProgramTaskState = {
  request: AttachProgramRequest;
  tool: DurableTool<any, any>;
  execution: ProgramExecutionValue;
  context?: DurableProgramContext;
  scope: Scope;
  destroyScope: () => Operation<void>;
  events: Queue<RuntimeEvent, never>;
  pending?: RuntimeBoundary;
  actionIndex: number;
  started: boolean;
  terminal: boolean;
  shutdown: boolean;
};

class RuntimeAttachmentHandle {
  constructor(readonly state: ProgramTaskState) {}
  toJSON(): never {
    throw new CrankError("invalid_descriptor", "Program attachments are runtime-only");
  }
}

/** Creates the process-local reference driver over one scope-owned Effection program task. */
export function createLocalProgramDriver(
  registry?: DurableToolRegistry,
  options: {
    readonly detachedScope?: boolean;
    readonly executionEffects?: DurableEffectRegistry;
    /** Tool Session composition supplies its foreign-child identity explicitly. */
    readonly foreignToolChild?: (request: ForeignToolRequest) => DurableChildDescriptor;
    /** Installs ordinary APIs/middleware in the attachment execution scope. */
    readonly setup?: () => Operation<void>;
  } = {},
): ProgramDriver {
  return {
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    *attach(request: AttachProgramRequest): Operation<ProgramAttachment> {
      const tools = registry ?? (yield* useDurableToolRegistry());
      const key = exactProgramKey(request.program);
      const tool = tools.get(key);
      if (!tool) {
        throw new CrankError("program_version_unavailable", `No exact program bundle for ${key}`);
      }
      const input = assertReplayedCanonicalValue(request.input, "invalid_descriptor");
      const canonicalRoute = canonicalSnapshot(request.route).value;
      const attachmentId = nextProgramAttachmentId(request);
      const executionScope = yield* ProgramExecutionScopeContext.get();
      const attachmentScope = options.detachedScope
        ? createScope()
        : createScope(executionScope ?? (yield* useScope()));
      const [scope, destroyScope] = attachmentScope;
      const acceptedRequest: AttachProgramRequest = {
        ...request,
        input,
        route: canonicalRoute,
      };
      const state: ProgramTaskState = {
        request: acceptedRequest,
        execution: createProgramExecutionValue(acceptedRequest, attachmentId),
        scope,
        destroyScope,
        events: createQueue<RuntimeEvent, never>(),
        tool,
        actionIndex: 0,
        started: false,
        terminal: false,
        shutdown: false,
      };
      return {
        attachmentId,
        taskId: request.taskId,
        driverKind: "program",
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
        const input = assertReplayedCanonicalValue(command.input, "invalid_descriptor");
        if (canonicalSnapshot(input).sha !== canonicalSnapshot(state.request.input).sha) {
          throw protocol("start input mismatch");
        }
        state.started = true;
        const context = createDurableProgramContext(
          (proposal) => {
            if (state.shutdown) {
              throw new CrankError("stale_program_capability", "Attachment is shutting down");
            }
            validateProposal(proposal);
            const resume = withResolvers<ProgramResume>("durable program boundary");
            state.events.add({ type: "proposal", boundary: { proposal, resume } });
            return resume.operation;
          },
          options.foreignToolChild ? { foreignToolChild: options.foreignToolChild } : {},
        );
        state.context = context;
        state.scope.run(function* () {
          yield* ProgramExecutionContext.set(state.execution);
          try {
            if (options.setup) {
              yield* options.setup();
            }
            const raw = yield* state.tool.program(input, context);
            const value = assertReplayedCanonicalValue(raw, "schema_validation_failed");
            assertInlineSize(value);
            state.events.add({ type: "completed", value });
          } catch (error) {
            state.events.add({ type: "failed", error: serializeDurableError(error) });
          }
        });
        return yield* nextStep(state);
      }
      if (!state.started || !state.pending) {
        throw protocol("command before a pending action");
      }
      if (command.type === "authorize") {
        return yield* authorizePending(state, command, options.executionEffects, options.setup);
      }
      if (command.type === "resume") {
        if (
          command.actionIndex !== state.actionIndex ||
          state.pending.proposal.type !== "operation"
        ) {
          throw protocol("resume action mismatch");
        }
        const pending = state.pending;
        delete state.pending;
        state.actionIndex += 1;
        pending.resume.resolve(canonicalOutcome(command.outcome));
        return yield* nextStep(state);
      }
      if (command.type === "ack_emission") {
        if (
          command.actionIndex !== state.actionIndex ||
          state.pending.proposal.type !== "emission"
        ) {
          throw protocol("emission acknowledgement mismatch");
        }
        const pending = state.pending;
        delete state.pending;
        state.actionIndex += 1;
        pending.resume.resolve(undefined);
        return yield* nextStep(state);
      }
      if (command.type === "cancel") {
        const pending = state.pending;
        delete state.pending;
        pending.resume.reject(new DurableProgramCancellation(command.reason));
        return yield* nextStep(state);
      }
      throw protocol("unknown program command");
    },

    *shutdown(attachment: ProgramAttachment, _reason: ProgramShutdownReason): Operation<void> {
      const state = attachmentState(attachment);
      if (state.shutdown) {
        return;
      }
      state.shutdown = true;
      const pending = state.pending;
      delete state.context;
      delete state.pending;
      pending?.resume.reject(
        new CrankError(
          "stale_program_capability",
          "Attachment was disposed without logical cancellation",
        ),
      );
      yield* state.destroyScope();
    },

    *manifest(program): Operation<DurableProgramManifest> {
      const tools = registry ?? (yield* useDurableToolRegistry());
      const tool = tools.get(exactProgramKey(program));
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

function* authorizePending(
  state: ProgramTaskState,
  command: Extract<ProgramCommand, { type: "authorize" }>,
  configuredEffects: DurableEffectRegistry | undefined,
  setup: (() => Operation<void>) | undefined,
): Operation<ProgramStep> {
  const proposal = state.pending!.proposal;
  if (command.actionIndex !== state.actionIndex || proposal.type !== "operation") {
    throw protocol("authorization action index mismatch");
  }
  if (proposal.descriptor.kind === "effect") {
    const registry = configuredEffects ?? (yield* ExecutionDurableEffectRegistryContext.get());
    const descriptor = command.descriptor ?? proposal.descriptor;
    const cancellation = yield* useAbortSignal();
    let outcome: OperationOutcome;
    try {
      if (!registry || descriptor.kind !== "effect" || !command.effectContractDigest) {
        throw new CrankError(
          "effect_placement_unavailable",
          "Execution effect implementation is unavailable",
        );
      }
      const registration = registry.get(`${descriptor.name}@${descriptor.version}`);
      if (
        !registration ||
        effectContractDigest(registration.definition) !== command.effectContractDigest
      ) {
        throw new CrankError(
          "effect_placement_unavailable",
          "Execution effect contract is unavailable",
        );
      }
      const disposition = yield* registration.handler(descriptor.input, {
        sessionId: state.request.sessionId,
        taskId: state.request.taskId,
        pullId: command.pullId,
        attemptId: command.attemptId,
        cancellation,
        resolver: descriptor.resolver,
      });
      outcome =
        disposition.status === "ok"
          ? {
              status: "ok",
              value: assertReplayedCanonicalValue(disposition.value, "schema_validation_failed"),
            }
          : disposition.status === "cancelled"
            ? disposition.partial === undefined
              ? { status: "cancelled" }
              : { status: "cancelled", partial: disposition.partial }
            : { status: "error", error: disposition.error };
    } catch (error) {
      outcome = cancellation.aborted
        ? { status: "cancelled" }
        : { status: "error", error: serializeDurableError(error) };
    }
    return authorizedStep(proposal, state.actionIndex, outcome);
  }
  if (proposal.descriptor.kind !== "record" || !proposal.execute) {
    throw protocol("authorization for non-executable action");
  }
  const cancellation = yield* useAbortSignal();
  let outcome: OperationOutcome;
  try {
    const value = yield* ProgramExecutionContext.with(state.execution, function* () {
      if (setup) {
        yield* setup();
      }
      return yield* proposal.execute!({
        pullId: command.pullId,
        attemptId: command.attemptId,
        cancellation,
      });
    });
    const recorded = assertReplayedCanonicalValue(value, "record_value_invalid");
    try {
      assertInlineSize(recorded);
    } catch (error) {
      throw new CrankError(
        "record_value_too_large",
        "Recorded value exceeds inline limit",
        undefined,
        { cause: error },
      );
    }
    outcome = { status: "ok", value: recorded };
  } catch (error) {
    outcome = cancellation.aborted
      ? { status: "cancelled" }
      : { status: "error", error: serializeDurableError(error) };
  }
  return authorizedStep(proposal, state.actionIndex, outcome);
}

function authorizedStep(
  proposal: Extract<ProgramStepProposal, { type: "operation" }>,
  actionIndex: number,
  outcome: OperationOutcome,
): ProgramStep {
  return {
    type: "operation",
    actionIndex,
    descriptor: structuredClone(proposal.descriptor),
    authorizedOutcome: outcome,
  };
}

function* nextStep(state: ProgramTaskState): Operation<ProgramStep> {
  const next = yield* state.events.next();
  if (next.done) {
    throw protocol("program event queue closed");
  }
  const event = next.value;
  if (event.type === "completed") {
    state.terminal = true;
    return { type: "completed", actionIndex: state.actionIndex, value: event.value };
  }
  if (event.type === "failed") {
    state.terminal = true;
    return { type: "failed", actionIndex: state.actionIndex, error: event.error };
  }
  state.pending = event.boundary;
  return proposalStep(event.boundary.proposal, state.actionIndex);
}

function proposalStep(proposal: ProgramStepProposal, actionIndex: number): ProgramStep {
  return proposal.type === "operation"
    ? { type: "operation", actionIndex, descriptor: structuredClone(proposal.descriptor) }
    : { type: "emission", actionIndex, descriptor: structuredClone(proposal.descriptor) };
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
  canonicalSnapshot(
    proposal.type === "operation"
      ? { type: proposal.type, descriptor: proposal.descriptor }
      : proposal,
  );
}

function attachmentState(attachment: ProgramAttachment): ProgramTaskState {
  if (!(attachment.handle instanceof RuntimeAttachmentHandle)) {
    throw protocol("foreign or serialized attachment");
  }
  return attachment.handle.state;
}

function assertLiveAttachment(attachment: ProgramAttachment, state: ProgramTaskState): void {
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

/** Canonical exact-key format shared by program registries and Hosts. */
export function exactProgramKey(program: PinnedProgram): string {
  return `${program.id}@${program.version}#${program.digest}`;
}

/** Derives a stable attachment identifier from pinned program and task identity. */
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
