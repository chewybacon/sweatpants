import {
  createContext,
  createScope,
  useAbortSignal,
  useScope,
  type Operation,
  type Scope,
} from "effection";

import {
  assertInlineSize,
  assertReplayedCanonicalValue,
  createDurableProgramContext,
  serializeDurableError,
  DurableProgramCancellation,
} from "./authoring.ts";
import { canonicalSnapshot, stableOpaqueId } from "./canonical.ts";
import { bindDurableProgramScope } from "./durable-program-scope.ts";
import { effectContractDigest } from "./effect-contract.ts";
import { validateProgramIdentityProvenance } from "./program-identity.ts";
import { CrankError, type Json } from "./types.ts";
import type {
  AttachProgramRequest,
  DurableEffectRegistry,
  DurableProgramContext,
  DurableProgramGenerator,
  DurableProgramManifest,
  DurableTool,
  OperationOutcome,
  PinnedProgram,
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramShutdownReason,
  ProgramStep,
  ProgramStepProposal,
} from "./durable-types.ts";

/** Program-ID keyed immutable registry of crank-native tool definitions. */
export type DurableToolRegistry = ReadonlyMap<string, DurableTool<any, any>>;
/** Driver-kind keyed immutable registry installed in an Effection scope. */
export type ProgramDriverRegistry = ReadonlyMap<string, ProgramDriver>;

/** Scoped durable-tool inventory used by local generator drivers. */
export const DurableToolRegistryContext = createContext<DurableToolRegistry | undefined>(
  "session-contract:durable-tool-registry",
  undefined,
);
/** Scoped driver inventory used by ProgramRuntime. */
export const ProgramDriverRegistryContext = createContext<ProgramDriverRegistry | undefined>(
  "session-contract:program-driver-registry",
  undefined,
);
/** Execution-local installed effects used only when routing selects program placement. */
export const ExecutionDurableEffectRegistryContext = createContext<
  DurableEffectRegistry | undefined
>("session-contract:execution-durable-effect-registry", undefined);

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

/** Builds a driver registry and rejects duplicate or empty driver kinds. */
export function createProgramDriverRegistry(
  drivers: Iterable<readonly [string, ProgramDriver]>,
): ProgramDriverRegistry {
  return new Map(drivers);
}

/** Resolves the current tool registry or fails fast outside an installed scope. */
export function* useDurableToolRegistry(): Operation<DurableToolRegistry> {
  const registry = yield* DurableToolRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No durable tool registry is installed");
  }
  return registry;
}

/** Resolves the current driver registry or fails fast outside an installed scope. */
export function* useProgramDriverRegistry(): Operation<ProgramDriverRegistry> {
  const registry = yield* ProgramDriverRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No program driver registry is installed");
  }
  return registry;
}

type GeneratorState = {
  request: AttachProgramRequest;
  tool: DurableTool<any, any>;
  generator?: DurableProgramGenerator;
  context?: DurableProgramContext;
  scope: Scope;
  destroyScope: () => Operation<void>;
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

/** Creates the process-local reference driver; generator state never crosses a process boundary. */
export function createLocalGeneratorDriver(
  registry?: DurableToolRegistry,
  options: {
    readonly detachedScope?: boolean;
    readonly executionEffects?: DurableEffectRegistry;
  } = {},
): ProgramDriver {
  return {
    *attach(request: AttachProgramRequest): Operation<ProgramAttachment> {
      const tools = registry ?? (yield* useDurableToolRegistry());
      const key = exactProgramKey(request.program);
      const tool = tools.get(key);
      if (!tool) {
        throw new CrankError("program_version_unavailable", `No exact program bundle for ${key}`);
      }
      // Attachment input was validated once at the authority acceptance
      // boundary; replay only re-checks canonical structure (DR-023).
      const input = assertReplayedCanonicalValue(request.input, "invalid_descriptor");
      const canonicalRoute = canonicalSnapshot(request.route).value;
      const attachmentId = nextProgramAttachmentId(request);
      const attachmentScope = options.detachedScope
        ? createScope()
        : createScope(yield* useScope());
      const [scope, destroyScope] = attachmentScope;
      const state: GeneratorState = {
        request: { ...request, input, route: canonicalRoute },
        scope,
        destroyScope,
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
        const input = assertReplayedCanonicalValue(command.input, "invalid_descriptor");
        if (canonicalSnapshot(input).sha !== canonicalSnapshot(state.request.input).sha) {
          throw protocol("start input mismatch");
        }
        state.started = true;
        try {
          const context = createDurableProgramContext();
          bindDurableProgramScope(context, state.scope);
          state.context = context;
          const generator = state.tool.program(input, context);
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
      if (state.context) {
        bindDurableProgramScope(state.context, state.scope);
      }
      if (command.type === "authorize") {
        if (command.actionIndex !== state.actionIndex || state.pending.type !== "operation") {
          throw protocol("authorization action index mismatch");
        }
        if (state.pending.descriptor.kind === "effect") {
          const registry =
            options.executionEffects ?? (yield* ExecutionDurableEffectRegistryContext.get());
          const descriptor = command.descriptor ?? state.pending.descriptor;
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
                    value: assertReplayedCanonicalValue(
                      disposition.value,
                      "schema_validation_failed",
                    ),
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
          return {
            type: "operation",
            actionIndex: state.actionIndex,
            descriptor: structuredClone(state.pending.descriptor),
            authorizedOutcome: outcome,
          };
        }
        if (state.pending.descriptor.kind !== "record" || !state.pending.execute) {
          throw protocol("authorization for non-executable action");
        }
        const cancellation = yield* useAbortSignal();
        let outcome: OperationOutcome;
        try {
          const value = yield* state.pending.execute({
            pullId: command.pullId,
            attemptId: command.attemptId,
            cancellation,
          });
          const recorded = assertReplayedCanonicalValue(value, "record_value_invalid");
          try {
            assertInlineSize(recorded);
          } catch (error) {
            throw new CrankError(
              "record_value_too_large",
              "Recorded value exceeds inline limit",
              undefined,
              {
                cause: error,
              },
            );
          }
          outcome = { status: "ok", value: recorded };
        } catch (error) {
          outcome = cancellation.aborted
            ? { status: "cancelled" }
            : { status: "error", error: serializeDurableError(error) };
        }
        return {
          type: "operation",
          actionIndex: state.actionIndex,
          descriptor: structuredClone(state.pending.descriptor),
          authorizedOutcome: outcome,
        };
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
          // The pending proposal has not been reserved, so cancellation does not
          // consume its action index. Catch/finally cleanup may safely propose at
          // the same frontier under normal durable execution rules.
          return advance(state, () =>
            generator.throw(new DurableProgramCancellation(command.reason)),
          );
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
      delete state.context;
      delete state.pending;
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

function advance(
  state: GeneratorState,
  next: () => IteratorResult<ProgramStepProposal, Json>,
): ProgramStep {
  try {
    const result = next();
    if (result.done) {
      delete state.pending;
      state.terminal = true;
      // Output is validated exactly once by the authority's registry-backed
      // complete(); the driver only enforces canonical JSON structure.
      const value = assertReplayedCanonicalValue(result.value, "schema_validation_failed");
      return { type: "completed", actionIndex: state.actionIndex, value };
    }
    validateProposal(result.value);
    state.pending = result.value;
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
  canonicalSnapshot(
    proposal.type === "operation"
      ? { type: proposal.type, descriptor: proposal.descriptor }
      : proposal,
  );
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
