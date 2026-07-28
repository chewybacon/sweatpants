import type { Operation } from "effection";
import { CrankError, createLocalProgramDriver } from "@sweatpants/session-contract";
import { canonicalSnapshot } from "@sweatpants/foundation";
import type { Json } from "@sweatpants/foundation";
import type {
  AttachProgramRequest,
  PinnedProgram,
  ProgramAttachment,
  ProgramCommand,
  ProgramStep,
  ReplayEntry,
} from "@sweatpants/durable-execution";
import type { DurableEffectRegistry, DurableToolRegistry } from "@sweatpants/session-contract";
import {
  a2aError,
  assertEnvelopeIdentity,
  computeA2AFrontierDigest,
  encodeA2AProgramMessage,
  parseClientProgramMessage,
  verifyA2AReplayEntry,
} from "./protocol.ts";
import {
  A2A_MAX_FRAME_BYTES,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type A2AProgramErrorCode,
  type ClientProgramMessageV1,
  type ExecutorHelloV1,
  type ServerProgramMessageV1,
  type WireProgramCommandV1,
} from "./types.ts";

export interface A2AExecutorPrincipal {
  readonly principalId: string;
  readonly tenantId?: string;
}

export interface A2AExecutorResourceLimits {
  /** Closed attachment after this many accepted commands; duplicates remain replayable. */
  readonly maxCommandsPerAttachment: number;
  readonly maxActiveAttachments: number;
  readonly maxEpochTombstones: number;
  readonly epochTombstoneTtlMs: number;
}

export interface A2AProgramExecutorOptions {
  readonly executorId: string;
  readonly computeGeneration: string;
  readonly registry: DurableToolRegistry;
  readonly executionEffects?: DurableEffectRegistry;
  readonly streamedRestore?: boolean;
  readonly resourceLimits?: Partial<A2AExecutorResourceLimits>;
  readonly authorize?: (principal: A2AExecutorPrincipal, program: PinnedProgram) => boolean;
  readonly observe?: (event: A2AExecutorObservation) => void;
}

export interface A2AExecutorObservation {
  event: "attached" | "step" | "duplicate" | "rejected" | "shutdown" | "stale_fenced";
  executorId: string;
  executionId: string;
  programDigest: string;
  executionEpoch: number;
  attachmentId?: string;
  actionIndex?: number;
  code?: A2AProgramErrorCode;
}

export interface A2AExecutorConnection {
  readonly hello: string;
  handle(frame: string | Uint8Array): Operation<string | undefined>;
  close(): Operation<void>;
}

export interface A2AProgramExecutor {
  openConnection(request: {
    principal: A2AExecutorPrincipal;
    activatedExtension: string;
  }): A2AExecutorConnection;
  latestEpoch(executionId: string): number | undefined;
  activeAttachmentCount(executionId?: string): number;
}

type ConnectionState = {
  principal: A2AExecutorPrincipal;
  attachment?: ProgramAttachment;
  identity?: Identity;
  input?: Json;
  step?: ProgramStep;
  replayChainSeed: string;
  replayChainDigest: string;
  replayedThrough: number;
  replayCount: number;
  restoring: boolean;
  shutdown: boolean;
  fenced: boolean;
  acceptedCommands: Map<string, { digest: string; response: ServerProgramMessageV1 }>;
  epochTracked: boolean;
};
type Identity = {
  executionId: string;
  program: PinnedProgram;
  executionEpoch: number;
};

/** Reference compute-only executor. It owns generator frames, never journal authority or credentials. */
export function createA2AProgramExecutor(options: A2AProgramExecutorOptions): A2AProgramExecutor {
  validateId(options.executorId, "executorId");
  validateId(options.computeGeneration, "computeGeneration");
  const driver = createLocalProgramDriver(options.registry, {
    detachedScope: true,
    ...(options.executionEffects ? { executionEffects: options.executionEffects } : {}),
  });
  const latestEpochs = new Map<string, { epoch: number; lastSeenAt: number; active: number }>();
  const states = new Set<ConnectionState>();
  const streamedRestore = options.streamedRestore ?? true;
  const limits = validateResourceLimits(options.resourceLimits);

  return {
    openConnection(request): A2AExecutorConnection {
      if (request.activatedExtension !== CALLER_AUTHORITATIVE_EXTENSION_URI) {
        throw a2aError("extension_not_activated", "Exact A2A extension activation is required");
      }
      if (!request.principal?.principalId) {
        throw a2aError("authentication_failed", "Authenticated executor principal is required");
      }
      const state: ConnectionState = {
        principal: Object.freeze({ ...request.principal }),
        replayChainSeed: "",
        replayChainDigest: "",
        replayedThrough: -1,
        replayCount: 0,
        restoring: false,
        shutdown: false,
        fenced: false,
        acceptedCommands: new Map(),
        epochTracked: false,
      };
      states.add(state);
      const hello: ExecutorHelloV1 = {
        type: "hello",
        protocolVersion: 1,
        extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
        executorId: options.executorId,
        maxFrameBytes: A2A_MAX_FRAME_BYTES,
        capabilities: { streamedRestore },
      };
      return {
        hello: encodeA2AProgramMessage(hello),
        *handle(frame): Operation<string | undefined> {
          const message = parseClientProgramMessage(frame);
          try {
            const response = yield* handleMessage(state, message);
            return response ? encodeA2AProgramMessage(response) : undefined;
          } catch (error) {
            const rejected = rejectionFor(message, error);
            observe(state, "rejected", rejected.payload.code, message.actionIndex);
            return encodeA2AProgramMessage(rejected);
          }
        },
        *close(): Operation<void> {
          if (!state.shutdown) {
            state.shutdown = true;
            if (state.attachment) {
              yield* driver.shutdown(state.attachment, "transport_lost");
            }
          }
          states.delete(state);
          releaseEpoch(state);
          pruneEpochTombstones();
        },
      };
    },
    latestEpoch(executionId) {
      return latestEpochs.get(executionId)?.epoch;
    },
    activeAttachmentCount(executionId) {
      let count = 0;
      for (const state of states) {
        if (
          state.attachment &&
          !state.shutdown &&
          !state.fenced &&
          (!executionId || state.identity?.executionId === executionId)
        ) {
          count += 1;
        }
      }
      return count;
    },
  };

  function* handleMessage(
    state: ConnectionState,
    message: ClientProgramMessageV1,
  ): Operation<ServerProgramMessageV1 | undefined> {
    if (state.shutdown) {
      throw protocol("Executor connection is closed");
    }
    if (state.fenced) {
      throw a2aError("stale_activation", "Executor attachment was fenced by a newer epoch");
    }
    if (message.type === "attach_begin" || message.type === "restore_begin") {
      if (state.attachment || state.identity) {
        throw protocol("Attach may occur only once per connection");
      }
      if (message.type === "restore_begin" && !streamedRestore) {
        throw protocol("Streamed restore is not implemented by this executor");
      }
      if (canonicalSnapshot(message.payload.input).sha !== message.payload.inputDigest) {
        throw protocol("Canonical child input digest mismatch");
      }
      if (options.authorize && !options.authorize(state.principal, message.program)) {
        throw a2aError("authorization_denied", "Requested program is unavailable");
      }
      yield* acceptEpoch(state, message);
      const request = remoteAttachRequest(message);
      state.identity = identityOf(message);
      state.input = message.payload.input;
      state.restoring = message.type === "restore_begin";
      if (message.type === "restore_begin") {
        state.replayChainSeed = message.payload.replayChainSeed;
        state.replayChainDigest = message.payload.replayChainSeed;
        state.replayedThrough = message.payload.replayedThroughActionIndex;
      }
      if (activeAttachmentCount() >= limits.maxActiveAttachments) {
        throw protocol("Executor active attachment limit exceeded");
      }
      state.attachment = yield* driver.attach(request);
      trackEpoch(state);
      observe(state, "attached");
      return responseEnvelope(
        state,
        message.type === "restore_begin" ? "restore_ready" : "attachment_ready",
        {
          attachmentId: state.attachment.attachmentId,
          computeGeneration: options.computeGeneration,
        },
        { attachmentId: state.attachment.attachmentId },
      );
    }

    const attachment = requireAttachment(state, message);
    if (message.type === "replay_operation" || message.type === "replay_emission") {
      if (!state.restoring) {
        throw protocol("Replay entry outside restore");
      }
      const entry = message.payload as ReplayEntry;
      if (!verifyA2AReplayEntry(state.replayChainSeed, state.replayChainDigest, entry)) {
        throw a2aError("replay_diverged", "Replay integrity chain mismatch");
      }
      if (!state.step) {
        state.step = yield* driver.step(attachment, { type: "start", input: requireInput(state) });
      }
      compareReplayStep(state.step, entry);
      state.replayChainDigest = entry.entryDigest;
      state.replayCount += 1;
      state.step =
        entry.type === "operation"
          ? yield* driver.step(attachment, {
              type: "resume",
              actionIndex: entry.actionIndex,
              outcome: entry.outcome,
              receipt: entry.receipt,
              replayed: true,
            })
          : yield* driver.step(attachment, {
              type: "ack_emission",
              actionIndex: entry.actionIndex,
              offset: entry.offset,
            });
      return undefined;
    }
    if (message.type === "replay_end") {
      if (!state.restoring) {
        throw protocol("Replay end outside restore");
      }
      if (
        message.payload.entryCount !== state.replayCount ||
        message.payload.replayChainDigest !== state.replayChainDigest
      ) {
        throw a2aError("history_not_exhausted", "Replay history end mismatch");
      }
      if (!state.step) {
        state.step = yield* driver.step(attachment, { type: "start", input: requireInput(state) });
      }
      if (state.step.actionIndex <= state.replayedThrough) {
        throw a2aError("history_not_exhausted", "Replay history was not exhausted");
      }
      state.restoring = false;
      const frontierDigest = computeA2AFrontierDigest({
        executionId: state.identity!.executionId,
        program: state.identity!.program,
        executionEpoch: state.identity!.executionEpoch,
        attachmentId: attachment.attachmentId,
        replayedThroughActionIndex: state.replayedThrough,
        replayChainDigest: state.replayChainDigest,
        step: state.step,
      });
      return responseEnvelope(
        state,
        "frontier",
        {
          step: state.step,
          replayedThroughActionIndex: state.replayedThrough,
          replayChainDigest: state.replayChainDigest,
          frontierDigest,
        },
        { attachmentId: attachment.attachmentId, actionIndex: state.step.actionIndex },
      );
    }
    if (state.restoring) {
      throw protocol("Live commands are forbidden before restore frontier");
    }
    if (message.type === "command" || message.type === "shutdown") {
      const commandId = message.commandId!;
      const commandDigest = canonicalSnapshot(message).sha;
      const accepted = state.acceptedCommands.get(commandId);
      if (accepted) {
        if (accepted.digest !== commandDigest) {
          throw a2aError("idempotency_conflict", "Command ID was reused with different content");
        }
        observe(state, "duplicate", undefined, message.actionIndex);
        return accepted.response;
      }
      if (state.acceptedCommands.size >= limits.maxCommandsPerAttachment) {
        throw protocol("Executor attachment command limit exceeded");
      }
      let response: ServerProgramMessageV1;
      if (message.type === "command") {
        state.step = yield* driver.step(attachment, inflateCommand(message.payload.command));
        response = responseEnvelope(
          state,
          "step",
          { step: state.step },
          {
            attachmentId: attachment.attachmentId,
            commandId,
            actionIndex: state.step.actionIndex,
          },
        );
        observe(state, "step", undefined, state.step.actionIndex);
      } else {
        yield* driver.shutdown(attachment, message.payload.reason);
        state.shutdown = true;
        response = responseEnvelope(
          state,
          "shutdown_complete",
          {},
          {
            attachmentId: attachment.attachmentId,
            commandId,
          },
        );
        observe(state, "shutdown");
      }
      state.acceptedCommands.set(commandId, { digest: commandDigest, response });
      return response;
    }
    throw protocol("Unexpected executor message");
  }

  function* acceptEpoch(state: ConnectionState, message: ClientProgramMessageV1): Operation<void> {
    pruneEpochTombstones();
    const latest = latestEpochs.get(message.executionId);
    if (latest !== undefined && message.executionEpoch < latest.epoch) {
      throw a2aError("stale_activation", "Execution epoch is stale");
    }
    if (latest === undefined || message.executionEpoch > latest.epoch) {
      latestEpochs.set(message.executionId, {
        epoch: message.executionEpoch,
        lastSeenAt: Date.now(),
        active: latest?.active ?? 0,
      });
      for (const candidate of states) {
        if (
          candidate !== state &&
          candidate.identity?.executionId === message.executionId &&
          candidate.identity.executionEpoch < message.executionEpoch
        ) {
          candidate.fenced = true;
          if (candidate.attachment && !candidate.shutdown) {
            yield* driver.shutdown(candidate.attachment, "transport_lost");
          }
          observe(candidate, "stale_fenced", "stale_activation");
        }
      }
    } else if (latest) {
      latest.lastSeenAt = Date.now();
    }
  }

  function activeAttachmentCount(): number {
    let count = 0;
    for (const state of states) {
      if (state.attachment && !state.shutdown && !state.fenced) {
        count += 1;
      }
    }
    return count;
  }

  function trackEpoch(state: ConnectionState): void {
    if (!state.identity || state.epochTracked) {
      return;
    }
    const entry = latestEpochs.get(state.identity.executionId);
    if (entry) {
      entry.active += 1;
      entry.lastSeenAt = Date.now();
      state.epochTracked = true;
    }
  }

  function releaseEpoch(state: ConnectionState): void {
    if (!state.identity || !state.epochTracked) {
      return;
    }
    const entry = latestEpochs.get(state.identity.executionId);
    if (entry) {
      entry.active = Math.max(0, entry.active - 1);
      entry.lastSeenAt = Date.now();
    }
    state.epochTracked = false;
  }

  function pruneEpochTombstones(): void {
    const now = Date.now();
    for (const [executionId, entry] of latestEpochs) {
      if (entry.active === 0 && now - entry.lastSeenAt >= limits.epochTombstoneTtlMs) {
        latestEpochs.delete(executionId);
      }
    }
    if (latestEpochs.size <= limits.maxEpochTombstones) {
      return;
    }
    const inactive = [...latestEpochs.entries()]
      .filter(([, entry]) => entry.active === 0)
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
    for (const [executionId] of inactive) {
      if (latestEpochs.size <= limits.maxEpochTombstones) {
        break;
      }
      latestEpochs.delete(executionId);
    }
  }

  function observe(
    state: ConnectionState,
    event: A2AExecutorObservation["event"],
    code?: A2AProgramErrorCode,
    actionIndex?: number,
  ): void {
    if (!state.identity) {
      return;
    }
    options.observe?.({
      event,
      executorId: options.executorId,
      executionId: state.identity.executionId,
      programDigest: state.identity.program.digest,
      executionEpoch: state.identity.executionEpoch,
      ...(state.attachment ? { attachmentId: state.attachment.attachmentId } : {}),
      ...(actionIndex !== undefined ? { actionIndex } : {}),
      ...(code ? { code } : {}),
    });
  }
}

function remoteAttachRequest(
  message: Extract<ClientProgramMessageV1, { type: "attach_begin" | "restore_begin" }>,
): AttachProgramRequest {
  return {
    sessionId: `remote:${message.executionId}`,
    taskId: message.executionId,
    program: message.program,
    input: message.payload.input,
    route: { driverKind: "program" },
    executionEpoch: message.executionEpoch,
    affinity: message.payload.affinity,
  };
}
function requireAttachment(
  state: ConnectionState,
  message: ClientProgramMessageV1,
): ProgramAttachment {
  if (!state.identity || !state.attachment) {
    throw protocol("Message before attach");
  }
  assertEnvelopeIdentity(message, {
    ...state.identity,
    attachmentId: state.attachment.attachmentId,
  });
  return state.attachment;
}
function identityOf(message: ClientProgramMessageV1): Identity {
  return {
    executionId: message.executionId,
    program: message.program,
    executionEpoch: message.executionEpoch,
  };
}
function requireInput(state: ConnectionState): Json {
  if (state.input === undefined) {
    throw protocol("Executor child input is missing");
  }
  return state.input;
}
function inflateCommand(command: WireProgramCommandV1): ProgramCommand {
  return command.type === "authorize"
    ? { ...command, resolutionCapability: "withheld-by-caller-authoritative-boundary" }
    : command;
}
function compareReplayStep(step: ProgramStep, entry: ReplayEntry): void {
  if (step.actionIndex !== entry.actionIndex || step.type !== entry.type) {
    throw a2aError("replay_diverged", "Replay action or kind mismatch");
  }
  if (step.type !== "operation" && step.type !== "emission") {
    throw a2aError("replay_diverged", "Program terminated before replay history ended");
  }
  const descriptorKind = step.type === "operation" ? step.descriptor.kind : "emission";
  if (
    descriptorKind !== entry.descriptorKind ||
    canonicalSnapshot(step.descriptor).sha !== entry.descriptorDigest
  ) {
    throw a2aError("replay_diverged", "Replay descriptor mismatch");
  }
}
function responseEnvelope<T extends ServerProgramMessageV1["type"]>(
  state: ConnectionState,
  type: T,
  payload: Extract<ServerProgramMessageV1, { type: T }>["payload"],
  scope: { attachmentId?: string; actionIndex?: number; commandId?: string } = {},
): Extract<ServerProgramMessageV1, { type: T }> {
  if (!state.identity) {
    throw protocol("Executor identity is not established");
  }
  return {
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    ...state.identity,
    type,
    ...scope,
    payload,
  } as Extract<ServerProgramMessageV1, { type: T }>;
}
function rejectionFor(
  message: ClientProgramMessageV1,
  error: unknown,
): Extract<ServerProgramMessageV1, { type: "rejected" }> {
  const code = allowedCode(error instanceof CrankError ? error.code : "program_protocol_error");
  const raw = error instanceof CrankError ? error.message : "Executor rejected the request";
  const safe = raw
    .replace(
      /(?:authorization|bearer|token|secret|password|credential)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .slice(0, 4096);
  return {
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    executionId: message.executionId,
    program: message.program,
    executionEpoch: message.executionEpoch,
    type: "rejected",
    ...(message.attachmentId ? { attachmentId: message.attachmentId } : {}),
    ...(message.actionIndex !== undefined ? { actionIndex: message.actionIndex } : {}),
    ...(message.commandId ? { commandId: message.commandId } : {}),
    payload: { code, message: safe },
  };
}
function allowedCode(value: string): A2AProgramErrorCode {
  const values = new Set<A2AProgramErrorCode>([
    "agent_card_invalid",
    "unsafe_url",
    "authentication_failed",
    "authorization_denied",
    "extension_not_advertised",
    "extension_not_activated",
    "extension_echo_mismatch",
    "protocol_version_unsupported",
    "manifest_not_found",
    "manifest_mismatch",
    "program_version_unavailable",
    "schema_version_unavailable",
    "effect_handler_missing",
    "effect_contract_mismatch",
    "identity_mismatch",
    "stale_activation",
    "idempotency_conflict",
    "payload_too_large",
    "replay_diverged",
    "history_not_exhausted",
    "program_protocol_error",
    "deadline_exceeded",
    "transport_lost",
  ]);
  return values.has(value as A2AProgramErrorCode)
    ? (value as A2AProgramErrorCode)
    : "program_protocol_error";
}
function validateResourceLimits(
  input: A2AProgramExecutorOptions["resourceLimits"],
): A2AExecutorResourceLimits {
  const limits: A2AExecutorResourceLimits = {
    maxCommandsPerAttachment: input?.maxCommandsPerAttachment ?? 100_000,
    maxActiveAttachments: input?.maxActiveAttachments ?? 1_024,
    maxEpochTombstones: input?.maxEpochTombstones ?? 100_000,
    epochTombstoneTtlMs: input?.epochTombstoneTtlMs ?? 24 * 60 * 60 * 1_000,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CrankError("invalid_descriptor", `${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function validateId(value: string, field: string): void {
  if (!value || value.length > 256) {
    throw new CrankError("invalid_descriptor", `Invalid ${field}`);
  }
}
function protocol(message: string): CrankError {
  return a2aError("program_protocol_error", message);
}
