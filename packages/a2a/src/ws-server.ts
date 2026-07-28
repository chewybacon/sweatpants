import { CrankError } from "@sweatpants/durable-execution";
import { run } from "effection";
import { WebSocket, type RawData } from "ws";

import type { A2AExecutorPrincipal, A2AProgramExecutor } from "./executor.ts";
import { A2A_MAX_FRAME_BYTES, CALLER_AUTHORITATIVE_EXTENSION_URI } from "./types.ts";
import { a2aError } from "./protocol.ts";

export interface BindA2AExecutorWebSocketOptions {
  readonly executor: A2AProgramExecutor;
  readonly principal: A2AExecutorPrincipal;
  readonly activatedExtensions: readonly string[];
  /** Receives unexpected executor/encoding failures; payloads are never logged here. */
  readonly onInternalError?: (error: unknown) => void;
}

/**
 * Binds an already authenticated/authorized WebSocket upgrade to the reference
 * executor. Upgrade authentication remains deployment-owned and must produce
 * the supplied principal before this function is called.
 */
export function bindA2AExecutorWebSocket(
  socket: WebSocket,
  options: BindA2AExecutorWebSocketOptions,
): void {
  if (!options.activatedExtensions.includes(CALLER_AUTHORITATIVE_EXTENSION_URI)) {
    socket.close(1008, "extension_not_activated");
    return;
  }
  const connection = options.executor.openConnection({
    principal: options.principal,
    activatedExtension: CALLER_AUTHORITATIVE_EXTENSION_URI,
  });
  socket.send(connection.hello);
  let sequence = Promise.resolve();
  let closed = false;
  socket.on("message", (data: RawData, binary) => {
    sequence = sequence.then(async () => {
      if (closed) {
        return;
      }
      const bytes = asBuffer(data);
      if (bytes.byteLength > A2A_MAX_FRAME_BYTES) {
        socket.close(1009, "payload_too_large");
        return;
      }
      const frame = binary ? new Uint8Array(bytes) : bytes.toString("utf8");
      try {
        const response = await run(() => connection.handle(frame));
        if (response !== undefined && socket.readyState === WebSocket.OPEN) {
          socket.send(response);
        }
      } catch (error) {
        // Parser failures have no trustworthy identity for a rejection frame.
        // Executor application rejections are already encoded by handle().
        if (error instanceof CrankError && error.code === "program_protocol_error") {
          socket.close(1002, "program_protocol_error");
        } else if (error instanceof CrankError && error.code === "payload_too_large") {
          socket.close(1009, "payload_too_large");
        } else {
          options.onInternalError?.(error);
          socket.close(1011, "executor_internal_error");
        }
      }
    });
  });
  const release = () => {
    if (closed) {
      return;
    }
    closed = true;
    void sequence.finally(() => run(() => connection.close()));
  };
  socket.once("close", release);
  socket.once("error", release);
}

export function parseActivatedA2AExtensions(
  header: string | readonly string[] | undefined,
): string[] {
  if (header === undefined) {
    return [];
  }
  const values: readonly string[] = Array.isArray(header) ? header : [header];
  const result = values
    .flatMap((value: string) => value.split(",").map((part: string) => part.trim()))
    .filter(Boolean);
  if (result.some((value) => /[\r\n]/.test(value))) {
    throw a2aError("extension_not_activated", "Invalid A2A extension activation header");
  }
  return [...new Set(result)];
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data as unknown as ArrayBuffer);
}
