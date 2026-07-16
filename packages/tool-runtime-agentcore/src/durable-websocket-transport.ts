import { call, useAbortSignal, type Operation } from "effection";

import {
  CrankError,
  canonicalSnapshot,
  type AgentCoreRuntimeRelease,
  type AgentCoreTaskPlacement,
  type AttachProgramRequest,
  type ProgramAttachment,
  type ProgramCommand,
  type ProgramRestoreRequest,
  type ProgramStep,
  type ReplayEntry,
  type RestoredProgramAttachment,
} from "@sweatpants/session-contract";
import type { AgentCoreDurableProgramTransport } from "./durable-driver.ts";
import {
  computeFrontierDigest,
  encodeAgentCoreProgramMessage,
  parseRuntimeProgramMessage,
  verifyReplayEntry,
  type HostProgramMessage,
  type RuntimeProgramMessage,
} from "./durable-protocol.ts";
import type {
  AgentCoreWebSocketConnection,
  AgentCoreWebSocketConnector,
} from "./durable-websocket-connector.ts";
import {
  createInvocationAgentCorePlacement,
  validateAgentCoreRuntimeRelease,
} from "./durable-placement.ts";

export type AgentCoreDurableProgramRoute =
  | {
      readonly driverKind: "agentcore";
      readonly placement: AgentCoreTaskPlacement;
    }
  | {
      readonly driverKind: "agentcore";
      readonly journalId: string;
      readonly release: AgentCoreRuntimeRelease;
    };

class AgentCoreAttachmentHandle {
  shutdown = false;
  constructor(
    readonly connection: AgentCoreWebSocketConnection,
    readonly placement: AgentCoreTaskPlacement,
    readonly taskId: string,
    readonly activationEpoch: number,
    readonly attachmentId: string,
  ) {}
  toJSON(): never {
    throw new CrankError("invalid_descriptor", "AgentCore attachment handles are runtime-only");
  }
}

/** Creates the activation-scoped V1 WebSocket transport used by ProgramDriver. */
export function createAgentCoreWebSocketProgramTransport(
  connector: AgentCoreWebSocketConnector,
): AgentCoreDurableProgramTransport {
  return {
    *attach(request): Operation<ProgramAttachment> {
      const restored = yield* openAndBegin(connector, request, -1, emptyDigest(), emptyDigest());
      return restored.attachment;
    },

    *restore(request): Operation<RestoredProgramAttachment> {
      const restored = yield* openAndBegin(
        connector,
        request.attach,
        request.replayedThroughActionIndex,
        request.replayChainSeed,
        request.replayChainDigest,
      );
      const handle = attachmentHandle(restored.attachment);
      let previous = request.replayChainSeed;
      let count = 0;
      yield* streamReplay(request, function* (entry) {
        if (!verifyReplayEntry(request.replayChainSeed, previous, entry)) {
          yield* handle.connection.close(1002, "replay_diverged");
          throw new CrankError("replay_diverged", "Replay integrity chain diverged");
        }
        yield* send(handle.connection, envelopeForEntry(handle, entry));
        previous = entry.entryDigest;
        count += 1;
      });
      if (previous !== request.replayChainDigest) {
        yield* handle.connection.close(1002, "replay_diverged");
        throw new CrankError("replay_diverged", "Replay chain end diverged");
      }
      yield* send(handle.connection, {
        protocolVersion: 1,
        type: "replay_end",
        releaseId: handle.placement.release.releaseId,
        taskId: handle.taskId,
        activationEpoch: handle.activationEpoch,
        attachmentId: handle.attachmentId,
        payload: { entryCount: count, replayChainDigest: previous },
      });
      const message = yield* receive(handle);
      if (message.type !== "frontier") throw protocol("Expected restored frontier");
      const computed = computeFrontierDigest({
        releaseId: handle.placement.release.releaseId,
        taskId: handle.taskId,
        activationEpoch: handle.activationEpoch,
        replayedThroughActionIndex: message.payload.replayedThroughActionIndex,
        replayChainDigest: message.payload.replayChainDigest,
        step: message.payload.step,
      });
      if (computed !== message.payload.frontierDigest) {
        yield* handle.connection.close(1002, "replay_diverged");
        throw new CrankError("replay_diverged", "Remote frontier digest mismatch");
      }
      return {
        attachment: restored.attachment,
        frontier: message.payload.step,
        replayedThroughActionIndex: message.payload.replayedThroughActionIndex,
        replayChainDigest: message.payload.replayChainDigest,
        frontierDigest: computed,
        computeGeneration: restored.computeGeneration,
      };
    },

    *step(attachment, command): Operation<ProgramStep> {
      const handle = attachmentHandle(attachment);
      assertLive(handle, attachment);
      yield* send(handle.connection, commandEnvelope(handle, command));
      const response = yield* receive(handle);
      if (response.type !== "step") throw protocol("Expected one program step");
      return response.payload.step;
    },

    *shutdown(attachment, reason): Operation<void> {
      const handle = attachmentHandle(attachment);
      if (handle.shutdown) return;
      handle.shutdown = true;
      try {
        yield* send(handle.connection, {
          protocolVersion: 1,
          type: "shutdown",
          releaseId: handle.placement.release.releaseId,
          taskId: handle.taskId,
          activationEpoch: handle.activationEpoch,
          attachmentId: handle.attachmentId,
          payload: { reason },
        });
        const response = yield* receive(handle);
        if (response.type !== "shutdown_complete")
          throw protocol("Expected shutdown acknowledgement");
      } catch (error) {
        if (
          reason !== "transport_lost" &&
          !(error instanceof CrankError && error.code === "agentcore_transport_lost")
        )
          throw error;
      } finally {
        yield* handle.connection.close(1000, reason);
      }
    },
  };
}

function* openAndBegin(
  connector: AgentCoreWebSocketConnector,
  request: AttachProgramRequest,
  replayedThroughActionIndex: number,
  replayChainSeed: string,
  _replayChainDigest: string,
): Operation<{ attachment: ProgramAttachment; computeGeneration: string }> {
  const placement = placementFrom(request);
  const signal = yield* useAbortSignal();
  const connection = yield* connector.connect({
    release: placement.release,
    runtimeSessionId: placement.runtimeSessionId,
    signal,
  });
  const begin: HostProgramMessage = {
    protocolVersion: 1,
    type: "restore_begin",
    releaseId: placement.release.releaseId,
    taskId: request.taskId,
    activationEpoch: request.executionEpoch,
    payload: {
      attach: request,
      programInputDigest: canonicalSnapshot(request.input).sha,
      replayedThroughActionIndex,
      replayChainSeed,
    },
  };
  try {
    yield* send(connection, begin);
    const ready = parseRuntimeProgramMessage(yield* connection.receive());
    if (ready.type === "rejected") throw rejected(ready);
    assertEnvelope(ready, placement, request.taskId, request.executionEpoch);
    if (ready.type !== "restore_ready") throw protocol("Expected restore_ready");
    const attachmentId = ready.payload.attachment.attachmentId;
    if (!attachmentId || ready.payload.attachment.taskId !== request.taskId)
      throw protocol("Remote attachment identity mismatch");
    const handle = new AgentCoreAttachmentHandle(
      connection,
      placement,
      request.taskId,
      request.executionEpoch,
      attachmentId,
    );
    return {
      attachment: {
        attachmentId,
        taskId: request.taskId,
        driverKind: "agentcore",
        route: request.route,
        executionEpoch: request.executionEpoch,
        handle,
      },
      computeGeneration: ready.payload.computeGeneration,
    };
  } catch (error) {
    yield* connection.close(1002, "attach_failed");
    throw error;
  }
}

function placementFrom(request: AttachProgramRequest): AgentCoreTaskPlacement {
  if (!request.route || typeof request.route !== "object" || Array.isArray(request.route))
    throw new CrankError("placement_unavailable", "Missing AgentCore placement route");
  const placement = request.route["placement"] as unknown;
  const deploymentRelease = request.route["release"] as unknown;
  const journalId = request.route["journalId"];
  const result =
    placement && typeof placement === "object" && !Array.isArray(placement)
      ? (placement as AgentCoreTaskPlacement)
      : deploymentRelease &&
          typeof deploymentRelease === "object" &&
          !Array.isArray(deploymentRelease) &&
          typeof journalId === "string"
        ? createInvocationAgentCorePlacement({
            journalId,
            rootTaskId: request.taskId,
            program: request.program,
            release: deploymentRelease as AgentCoreRuntimeRelease,
          })
        : undefined;
  if (!result) throw new CrankError("placement_unavailable", "Missing AgentCore private placement");
  validateAgentCoreRuntimeRelease(result.release);
  if (
    result.taskId !== request.taskId ||
    result.program.id !== request.program.id ||
    result.program.version !== request.program.version ||
    result.program.digest !== request.program.digest ||
    result.affinity.kind !== "invocation"
  ) {
    throw new CrankError(
      "sandbox_task_mismatch",
      "AgentCore task placement does not match attach request",
    );
  }
  return result;
}

function* send(
  connection: AgentCoreWebSocketConnection,
  message: HostProgramMessage,
): Operation<void> {
  yield* connection.send(encodeAgentCoreProgramMessage(message));
}

function* receive(handle: AgentCoreAttachmentHandle): Operation<RuntimeProgramMessage> {
  const message = parseRuntimeProgramMessage(yield* handle.connection.receive());
  assertEnvelope(
    message,
    handle.placement,
    handle.taskId,
    handle.activationEpoch,
    handle.attachmentId,
  );
  if (message.type === "rejected") throw rejected(message);
  return message;
}

function assertEnvelope(
  message: RuntimeProgramMessage,
  placement: AgentCoreTaskPlacement,
  taskId: string,
  epoch: number,
  attachmentId?: string,
): void {
  if (
    message.releaseId !== placement.release.releaseId ||
    message.taskId !== taskId ||
    message.activationEpoch !== epoch ||
    (attachmentId !== undefined && message.attachmentId !== attachmentId)
  )
    throw protocol("Remote protocol identity mismatch");
}

function commandEnvelope(
  handle: AgentCoreAttachmentHandle,
  command: ProgramCommand,
): HostProgramMessage {
  const indexed =
    command.type === "resume" || command.type === "authorize" || command.type === "ack_emission";
  return {
    protocolVersion: 1,
    type: "command",
    releaseId: handle.placement.release.releaseId,
    taskId: handle.taskId,
    activationEpoch: handle.activationEpoch,
    attachmentId: handle.attachmentId,
    ...(indexed ? { actionIndex: command.actionIndex } : {}),
    payload: { command },
  };
}

function envelopeForEntry(
  handle: AgentCoreAttachmentHandle,
  entry: ReplayEntry,
): HostProgramMessage {
  return {
    protocolVersion: 1,
    type: entry.type === "operation" ? "replay_operation" : "replay_emission",
    releaseId: handle.placement.release.releaseId,
    taskId: handle.taskId,
    activationEpoch: handle.activationEpoch,
    attachmentId: handle.attachmentId,
    actionIndex: entry.actionIndex,
    payload: entry,
  } as HostProgramMessage;
}

function* streamReplay(
  request: ProgramRestoreRequest,
  visit: (entry: ReplayEntry) => Operation<void>,
): Operation<void> {
  const replay = request.replay;
  const asyncIterator = replay[Symbol.asyncIterator];
  if (asyncIterator) {
    const source = asyncIterator.call(replay);
    while (true) {
      const next = yield* call(() => source.next());
      if (next.done) return;
      yield* visit(next.value);
    }
  }
  const iterator = replay[Symbol.iterator];
  if (iterator) {
    const source = iterator.call(replay);
    let next = source.next();
    while (!next.done) {
      yield* visit(next.value);
      next = source.next();
    }
    return;
  }
  throw protocol("Replay source is not iterable");
}

function attachmentHandle(attachment: ProgramAttachment): AgentCoreAttachmentHandle {
  if (!(attachment.handle instanceof AgentCoreAttachmentHandle))
    throw protocol("Foreign or serialized AgentCore attachment");
  return attachment.handle;
}
function assertLive(handle: AgentCoreAttachmentHandle, attachment: ProgramAttachment): void {
  if (
    handle.shutdown ||
    attachment.taskId !== handle.taskId ||
    attachment.executionEpoch !== handle.activationEpoch ||
    attachment.attachmentId !== handle.attachmentId
  )
    throw new CrankError("stale_activation", "Stale AgentCore attachment");
}
function rejected(message: Extract<RuntimeProgramMessage, { type: "rejected" }>): CrankError {
  return new CrankError(message.payload.code, message.payload.message);
}
function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}
function emptyDigest(): string {
  return "0".repeat(64);
}
