import { CrankError, REPLAY_CHECKPOINT_CAPABILITIES } from "@sweatpants/durable-execution";
import { call, race, sleep, useAbortSignal, type Operation } from "effection";
import { canonicalJson, canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import type { Json } from "@sweatpants/foundation";

import type {
  AttachProgramRequest,
  DurableProgramManifest,
  PinnedProgram,
  ProgramAttachment,
  ProgramDriver,
  ProgramRestoreRequest,
  ProgramStep,
  ReplayEntry,
  RestoredProgramAttachment,
} from "@sweatpants/durable-execution";
import type { A2AWebSocketConnection, A2AWebSocketConnector } from "./connector.ts";
import {
  assertEnvelopeIdentity,
  computeA2ACommandId,
  computeA2AFrontierDigest,
  encodeA2AProgramMessage,
  parseExecutorHello,
  parseServerProgramMessage,
  projectProgramCommand,
  verifyA2AReplayEntry,
  a2aError,
} from "./protocol.ts";
import {
  A2A_MAX_INLINE_INPUT_BYTES,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type A2AProgramRouteV1,
  type ClientProgramMessageV1,
  type RemoteProgramManifestDocumentV1,
  type ServerProgramMessageV1,
} from "./types.ts";

export interface A2AProgramDriverDeadlines {
  handshakeMs: number;
  attachMs: number;
  stepMs: number;
  restoreProgressMs: number;
}

export interface A2AProgramDriverOptions {
  connector: A2AWebSocketConnector;
  manifest(
    program: PinnedProgram,
  ): Promise<RemoteProgramManifestDocumentV1 | DurableProgramManifest>;
  streamedRestore?: boolean;
  deadlines?: Partial<A2AProgramDriverDeadlines>;
  observe?: (event: A2ADriverObservation) => void;
}

export interface A2ADriverObservation {
  event: "connected" | "attached" | "step" | "shutdown" | "transport_lost" | "rejected";
  executionId: string;
  programDigest: string;
  executionEpoch: number;
  attachmentId?: string;
  actionIndex?: number;
  code?: string;
}

const DEFAULT_DEADLINES: A2AProgramDriverDeadlines = {
  handshakeMs: 10_000,
  attachMs: 30_000,
  stepMs: 120_000,
  restoreProgressMs: 30_000,
};

class A2AAttachmentHandle {
  shutdown = false;
  constructor(
    readonly connection: A2AWebSocketConnection,
    readonly route: A2AProgramRouteV1,
    readonly program: PinnedProgram,
    readonly executionEpoch: number,
    readonly attachmentId: string,
  ) {}
  toJSON(): never {
    throw new CrankError("invalid_descriptor", "A2A attachment handles are runtime-only");
  }
}

/** Projects ProgramDriver over authenticated A2A-negotiated WSS; the caller journal stays authoritative. */
export function createA2AProgramDriver(options: A2AProgramDriverOptions): ProgramDriver {
  const deadlines = parseA2AProgramDriverDeadlines({ ...DEFAULT_DEADLINES, ...options.deadlines });
  const base: ProgramDriver = {
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    *attach(request): Operation<ProgramAttachment> {
      assertInlineInput(request.input);
      const opened = yield* openConnection(options, deadlines, request, false);
      try {
        const inputDigest = canonicalSnapshot(request.input).sha;
        yield* send(
          opened.connection,
          envelope(request, opened.route, "attach_begin", {
            input: request.input,
            inputDigest,
            affinity: request.affinity ?? { kind: "invocation", key: request.taskId },
          }),
        );
        const ready = yield* receiveWithin(opened.connection, deadlines.attachMs, "attach");
        assertResponse(ready, request, opened.route);
        if (ready.type !== "attachment_ready") {
          throw protocol("Expected attachment_ready");
        }
        const attachment = makeAttachment(
          request,
          opened.route,
          opened.connection,
          ready.payload.attachmentId,
        );
        observe(options, "attached", request, opened.route, attachment.attachmentId);
        return attachment;
      } catch (error) {
        yield* closeFailed(opened.connection, error);
        throw error;
      }
    },

    *step(attachment, command): Operation<ProgramStep> {
      const handle = attachmentHandle(attachment);
      assertLive(handle, attachment);
      const projected = projectProgramCommand(command);
      const commandId = computeA2ACommandId({
        executionId: handle.route.executionId,
        executionEpoch: handle.executionEpoch,
        attachmentId: handle.attachmentId,
        command: projected,
      });
      const indexed = "actionIndex" in projected;
      const message = handleEnvelope(
        handle,
        "command",
        { command: projected },
        {
          commandId,
          ...(indexed ? { actionIndex: projected.actionIndex } : {}),
        },
      );
      try {
        yield* send(handle.connection, message);
        const response = yield* receiveWithin(handle.connection, deadlines.stepMs, "step");
        assertHandleResponse(response, handle);
        if (response.commandId !== commandId) {
          throw identity("Command response identity mismatch");
        }
        if (response.type !== "step") {
          throw protocol("Expected exactly one program step");
        }
        observe(
          options,
          "step",
          fromHandle(handle),
          handle.route,
          handle.attachmentId,
          response.actionIndex,
        );
        return response.payload.step;
      } catch (error) {
        if (isTransport(error)) {
          observe(
            options,
            "transport_lost",
            fromHandle(handle),
            handle.route,
            handle.attachmentId,
            undefined,
            codeOf(error),
          );
          yield* handle.connection.close(1011, "transport_lost");
        }
        throw error;
      }
    },

    *shutdown(attachment, reason): Operation<void> {
      const handle = attachmentHandle(attachment);
      if (handle.shutdown) {
        return;
      }
      handle.shutdown = true;
      const commandId = stableControlId(handle, "shutdown");
      try {
        yield* send(
          handle.connection,
          handleEnvelope(handle, "shutdown", { reason }, { commandId }),
        );
        const response = yield* receiveWithin(handle.connection, deadlines.stepMs, "shutdown");
        assertHandleResponse(response, handle);
        if (response.commandId !== commandId || response.type !== "shutdown_complete") {
          throw protocol("Expected shutdown_complete");
        }
      } catch (error) {
        if (reason !== "transport_lost" && !isTransport(error)) {
          throw error;
        }
      } finally {
        observe(options, "shutdown", fromHandle(handle), handle.route, handle.attachmentId);
        yield* handle.connection.close(1000, reason);
      }
    },

    *manifest(program): Operation<DurableProgramManifest> {
      const result = yield* call(() => options.manifest(projectPinnedProgram(program)));
      return "manifest" in result ? result.manifest : result;
    },
  };

  if (options.streamedRestore === false) {
    return base;
  }
  return {
    ...base,
    *restoreContext(request) {
      const route = routeFrom(request);
      return {
        replayDomain: "sweatpants.a2a.replay.v1",
        frontierDomain: "sweatpants.a2a.frontier.v1",
        releaseId: request.program.digest,
        sandboxSessionId: route.executionId,
      };
    },
    *restore(request): Operation<RestoredProgramAttachment> {
      assertInlineInput(request.attach.input);
      const opened = yield* openConnection(options, deadlines, request.attach, true);
      try {
        const inputDigest = canonicalSnapshot(request.attach.input).sha;
        yield* send(
          opened.connection,
          envelope(request.attach, opened.route, "restore_begin", {
            input: request.attach.input,
            inputDigest,
            replayedThroughActionIndex: request.replayedThroughActionIndex,
            replayChainSeed: request.replayChainSeed,
            affinity: request.attach.affinity ?? {
              kind: "invocation",
              key: request.attach.taskId,
            },
          }),
        );
        const ready = yield* receiveWithin(opened.connection, deadlines.attachMs, "restore attach");
        assertResponse(ready, request.attach, opened.route);
        if (ready.type !== "restore_ready") {
          throw protocol("Expected restore_ready");
        }
        const attachment = makeAttachment(
          request.attach,
          opened.route,
          opened.connection,
          ready.payload.attachmentId,
        );
        const handle = attachmentHandle(attachment);
        let previous = request.replayChainSeed;
        let count = 0;
        yield* streamReplay(request, function* (entry) {
          if (!verifyA2AReplayEntry(request.replayChainSeed, previous, entry)) {
            throw a2aError("replay_diverged", "Caller replay integrity chain diverged");
          }
          yield* send(
            opened.connection,
            handleEnvelope(
              handle,
              entry.type === "operation" ? "replay_operation" : "replay_emission",
              entry,
              { actionIndex: entry.actionIndex },
            ) as ClientProgramMessageV1,
          );
          previous = entry.entryDigest;
          count += 1;
        });
        if (previous !== request.replayChainDigest) {
          throw a2aError("replay_diverged", "Caller replay chain end diverged");
        }
        yield* send(
          opened.connection,
          handleEnvelope(handle, "replay_end", {
            entryCount: count,
            replayChainDigest: previous,
          }),
        );
        const frontier = yield* receiveWithin(
          opened.connection,
          deadlines.restoreProgressMs,
          "restore frontier",
        );
        assertHandleResponse(frontier, handle);
        if (frontier.type !== "frontier") {
          throw protocol("Expected restored frontier");
        }
        const computed = computeA2AFrontierDigest({
          executionId: handle.route.executionId,
          program: handle.program,
          executionEpoch: handle.executionEpoch,
          attachmentId: handle.attachmentId,
          replayedThroughActionIndex: frontier.payload.replayedThroughActionIndex,
          replayChainDigest: frontier.payload.replayChainDigest,
          step: frontier.payload.step,
        });
        if (frontier.payload.frontierDigest !== computed) {
          throw a2aError("replay_diverged", "Remote frontier digest mismatch");
        }
        // The remote digest proves the closed public A2A identity. The authority
        // proof remains caller-private and uses its existing task/release domain.
        const authorityFrontierDigest = sha256(
          canonicalJson({
            domain: "sweatpants.a2a.frontier.v1",
            protocolVersion: 1,
            releaseId: request.attach.program.digest,
            taskId: request.attach.taskId,
            activationEpoch: request.attach.executionEpoch,
            replayedThroughActionIndex: frontier.payload.replayedThroughActionIndex,
            replayChainDigest: frontier.payload.replayChainDigest,
            step: frontier.payload.step,
          }),
        );
        return {
          attachment,
          frontier: frontier.payload.step,
          replayedThroughActionIndex: frontier.payload.replayedThroughActionIndex,
          replayChainDigest: frontier.payload.replayChainDigest,
          frontierDigest: authorityFrontierDigest,
          computeGeneration: ready.payload.computeGeneration,
        };
      } catch (error) {
        yield* closeFailed(opened.connection, error);
        throw error;
      }
    },
  };
}

function* openConnection(
  options: A2AProgramDriverOptions,
  deadlines: A2AProgramDriverDeadlines,
  request: AttachProgramRequest,
  requiresRestore: boolean,
): Operation<{ connection: A2AWebSocketConnection; route: A2AProgramRouteV1 }> {
  const route = routeFrom(request);
  const signal = yield* useAbortSignal();
  const connection = yield* within(
    options.connector.connect({
      endpoint: route.driverEndpoint,
      cardOrigin: route.cardOrigin,
      executionId: route.executionId,
      signal,
    }),
    deadlines.handshakeMs,
    "handshake",
  );
  try {
    const hello = parseExecutorHello(
      yield* receiveRawWithin(connection, deadlines.handshakeMs, "extension hello"),
    );
    if (requiresRestore && !hello.capabilities.streamedRestore) {
      throw protocol("Executor did not advertise streamed restore");
    }
    observe(options, "connected", request, route);
    return { connection, route };
  } catch (error) {
    yield* connection.close(1002, "negotiation_failed");
    throw error;
  }
}

function routeFrom(request: AttachProgramRequest): A2AProgramRouteV1 {
  const route = request.route;
  if (!record(route)) {
    throw a2aError("identity_mismatch", "Missing A2A program route");
  }
  const keys = [
    "driverKind",
    "protocolVersion",
    "extensionUri",
    "executionId",
    "driverEndpoint",
    "cardOrigin",
  ];
  if (Object.keys(route).length !== keys.length || !keys.every((key) => key in route)) {
    throw a2aError("identity_mismatch", "A2A route fields are not closed");
  }
  if (
    route["driverKind"] !== "a2a" ||
    route["protocolVersion"] !== 1 ||
    route["extensionUri"] !== CALLER_AUTHORITATIVE_EXTENSION_URI ||
    !nonempty(route["executionId"]) ||
    typeof route["driverEndpoint"] !== "string" ||
    typeof route["cardOrigin"] !== "string"
  ) {
    throw a2aError("identity_mismatch", "Invalid pinned A2A route");
  }
  return route as unknown as A2AProgramRouteV1;
}

function envelope<T extends string, P>(
  request: AttachProgramRequest,
  route: A2AProgramRouteV1,
  type: T,
  payload: P,
): ClientProgramMessageV1 {
  return {
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    executionId: route.executionId,
    program: projectPinnedProgram(request.program),
    executionEpoch: request.executionEpoch,
    type,
    payload,
  } as unknown as ClientProgramMessageV1;
}

function handleEnvelope<T extends string, P>(
  handle: A2AAttachmentHandle,
  type: T,
  payload: P,
  scope: { commandId?: string; actionIndex?: number } = {},
): ClientProgramMessageV1 {
  return {
    protocolVersion: 1,
    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
    executionId: handle.route.executionId,
    program: handle.program,
    executionEpoch: handle.executionEpoch,
    type,
    attachmentId: handle.attachmentId,
    ...scope,
    payload,
  } as unknown as ClientProgramMessageV1;
}

function makeAttachment(
  request: AttachProgramRequest,
  route: A2AProgramRouteV1,
  connection: A2AWebSocketConnection,
  attachmentId: string,
): ProgramAttachment {
  return {
    attachmentId,
    taskId: request.taskId,
    driverKind: "a2a",
    route: request.route,
    executionEpoch: request.executionEpoch,
    handle: new A2AAttachmentHandle(
      connection,
      route,
      projectPinnedProgram(request.program),
      request.executionEpoch,
      attachmentId,
    ),
  };
}

function* send(
  connection: A2AWebSocketConnection,
  message: ClientProgramMessageV1,
): Operation<void> {
  yield* connection.send(encodeA2AProgramMessage(message));
}
function* receiveWithin(
  connection: A2AWebSocketConnection,
  timeoutMs: number,
  phase: string,
): Operation<ServerProgramMessageV1> {
  const response = parseServerProgramMessage(yield* receiveRawWithin(connection, timeoutMs, phase));
  if (response.type === "rejected") {
    throw rejected(response);
  }
  return response;
}
function* receiveRawWithin(
  connection: A2AWebSocketConnection,
  timeoutMs: number,
  phase: string,
): Operation<string | Uint8Array> {
  return yield* within(connection.receive(), timeoutMs, phase);
}
function* within<T>(operation: Operation<T>, timeoutMs: number, phase: string): Operation<T> {
  // Effection halts the losing receive branch. Callers classify the deadline as
  // transport loss and close this attachment, so a late response cannot be
  // accepted; recovery always creates a fresh attachment and replays history.
  return (yield* race([
    operation,
    (function* (): Operation<never> {
      yield* sleep(timeoutMs);
      throw a2aError("deadline_exceeded", `A2A ${phase} deadline exceeded`);
    })(),
  ])) as T;
}
function* closeFailed(connection: A2AWebSocketConnection, error: unknown): Operation<void> {
  yield* connection.close(1011, isTransport(error) ? "transport_lost" : "protocol_error");
}
function assertResponse(
  response: ServerProgramMessageV1,
  request: AttachProgramRequest,
  route: A2AProgramRouteV1,
): void {
  assertEnvelopeIdentity(response, {
    executionId: route.executionId,
    program: projectPinnedProgram(request.program),
    executionEpoch: request.executionEpoch,
  });
}
function assertHandleResponse(response: ServerProgramMessageV1, handle: A2AAttachmentHandle): void {
  assertEnvelopeIdentity(response, {
    executionId: handle.route.executionId,
    program: handle.program,
    executionEpoch: handle.executionEpoch,
    attachmentId: handle.attachmentId,
  });
}
function attachmentHandle(attachment: ProgramAttachment): A2AAttachmentHandle {
  if (!(attachment.handle instanceof A2AAttachmentHandle)) {
    throw protocol("Foreign or serialized A2A attachment");
  }
  return attachment.handle;
}
function assertLive(handle: A2AAttachmentHandle, attachment: ProgramAttachment): void {
  if (
    handle.shutdown ||
    attachment.attachmentId !== handle.attachmentId ||
    attachment.executionEpoch !== handle.executionEpoch ||
    attachment.driverKind !== "a2a"
  ) {
    throw a2aError("stale_activation", "Stale A2A attachment");
  }
}
function stableControlId(handle: A2AAttachmentHandle, type: string): string {
  return `cmd_${sha256(
    canonicalJson({
      domain: "sweatpants.a2a.command.v1",
      executionId: handle.route.executionId,
      executionEpoch: handle.executionEpoch,
      attachmentId: handle.attachmentId,
      commandType: type,
    }),
  ).slice(0, 40)}`;
}
function assertInlineInput(input: Json): void {
  if (new TextEncoder().encode(canonicalJson(input)).byteLength > A2A_MAX_INLINE_INPUT_BYTES) {
    throw a2aError("payload_too_large", "A2A child input exceeds the 1 MiB authority inline bound");
  }
}
function* streamReplay(
  request: ProgramRestoreRequest,
  visit: (entry: ReplayEntry) => Operation<void>,
): Operation<void> {
  const asyncIterator = request.replay[Symbol.asyncIterator];
  if (asyncIterator) {
    const iterator = asyncIterator.call(request.replay);
    while (true) {
      const next = yield* call(() => iterator.next());
      if (next.done) {
        return;
      }
      yield* visit(next.value);
    }
  }
  const syncIterator = request.replay[Symbol.iterator];
  if (!syncIterator) {
    throw protocol("Replay source is not iterable");
  }
  const iterator = syncIterator.call(request.replay);
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    yield* visit(next.value);
  }
}
function parseA2AProgramDriverDeadlines(
  value: A2AProgramDriverDeadlines,
): A2AProgramDriverDeadlines {
  for (const deadline of Object.values(value)) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0) {
      throw new CrankError("invalid_descriptor", "A2A deadlines must be positive integers");
    }
  }
  return Object.freeze(value);
}
function rejected(message: Extract<ServerProgramMessageV1, { type: "rejected" }>): CrankError {
  return a2aError(message.payload.code, message.payload.message);
}
function identity(message: string): CrankError {
  return a2aError("identity_mismatch", message);
}
function protocol(message: string): CrankError {
  return a2aError("program_protocol_error", message);
}
function isTransport(error: unknown): boolean {
  return (
    error instanceof CrankError && ["transport_lost", "deadline_exceeded"].includes(error.code)
  );
}
function codeOf(error: unknown): string {
  return error instanceof CrankError ? error.code : "transport_lost";
}
function observe(
  options: A2AProgramDriverOptions,
  event: A2ADriverObservation["event"],
  request: AttachProgramRequest,
  route: A2AProgramRouteV1,
  attachmentId?: string,
  actionIndex?: number,
  code?: string,
): void {
  options.observe?.({
    event,
    executionId: route.executionId,
    programDigest: request.program.digest,
    executionEpoch: request.executionEpoch,
    ...(attachmentId ? { attachmentId } : {}),
    ...(actionIndex !== undefined ? { actionIndex } : {}),
    ...(code ? { code } : {}),
  });
}
function fromHandle(handle: A2AAttachmentHandle): AttachProgramRequest {
  return {
    sessionId: "redacted",
    taskId: "redacted",
    program: handle.program,
    input: null,
    route: handle.route as unknown as Json,
    executionEpoch: handle.executionEpoch,
  };
}
function projectPinnedProgram(program: PinnedProgram): PinnedProgram {
  return { id: program.id, version: program.version, digest: program.digest };
}

function record(value: Json): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
