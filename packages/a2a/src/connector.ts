import { CrankError } from "@sweatpants/durable-execution";
import { isIP, type LookupFunction } from "node:net";

import { call, type Operation } from "effection";
import { WebSocket, type RawData } from "ws";

import {
  A2A_EXTENSIONS_HEADER,
  A2A_MAX_FRAME_BYTES,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type A2ARequestAuthorization,
} from "./types.ts";
import { a2aError } from "./protocol.ts";
import { validateA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";

export interface A2AWebSocketConnection {
  send(frame: string | Uint8Array): Operation<void>;
  receive(): Operation<string | Uint8Array>;
  close(code?: number, reason?: string): Operation<void>;
}

export interface A2AWebSocketConnectRequest {
  endpoint: string;
  cardOrigin: string;
  executionId: string;
  signal: AbortSignal;
}

export interface A2AWebSocketConnector {
  connect(request: A2AWebSocketConnectRequest): Operation<A2AWebSocketConnection>;
}

export type A2ADriverAuthorizationProvider = (
  endpoint: URL,
  executionId: string,
) => Promise<A2ARequestAuthorization | undefined> | A2ARequestAuthorization | undefined;

export interface NodeA2AWebSocketConnectorOptions {
  readonly urlPolicy?: A2AUrlPolicy;
  readonly authorization?: A2ADriverAuthorizationProvider;
  readonly webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

/** WSS connector with explicit extension activation and DNS-policy pinning. */
export function createNodeA2AWebSocketConnector(
  options: NodeA2AWebSocketConnectorOptions = {},
): A2AWebSocketConnector {
  const factory = options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  return {
    *connect(request): Operation<A2AWebSocketConnection> {
      if (request.signal.aborted) {
        throw transportLost();
      }
      const validated = yield* call(() =>
        validateA2AUrl(request.endpoint, {
          purpose: "driver",
          ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
          cardOrigin: request.cardOrigin,
        }),
      );
      const authorization = yield* call(async () =>
        options.authorization?.(validated.url, request.executionId),
      );
      const headers: Record<string, string> = {
        [A2A_EXTENSIONS_HEADER]: CALLER_AUTHORITATIVE_EXTENSION_URI,
        ...authorization?.headers,
      };
      validateHeaders(headers);
      const socketOptions = {
        headers,
        maxPayload: A2A_MAX_FRAME_BYTES,
        perMessageDeflate: false,
        lookup: createPinnedLookup(validated.addresses),
      } as WebSocket.ClientOptions & { lookup: LookupFunction };
      const socket = factory(validated.url.toString(), socketOptions);
      // Install frame buffering before awaiting `open`: the server's mandatory
      // hello may arrive in the same turn as the upgrade and must not be lost.
      const connection = connectionFor(socket, request.signal);
      try {
        yield* call(() => opened(socket, request.signal));
      } catch (error) {
        socket.terminate();
        if (error instanceof CrankError) {
          throw error;
        }
        throw a2aError("authentication_failed", "A2A WebSocket handshake failed", error);
      }
      return connection;
    },
  };
}

function connectionFor(socket: WebSocket, signal: AbortSignal): A2AWebSocketConnection {
  const frames: Array<string | Uint8Array> = [];
  const waiters: Array<{
    resolve: (frame: string | Uint8Array) => void;
    reject: (error: unknown) => void;
  }> = [];
  let terminal: CrankError | undefined;
  const fail = (error = transportLost()) => {
    terminal ??= error;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(terminal);
    }
  };
  socket.on("message", (data: RawData, binary) => {
    const bytes = asBuffer(data);
    const frame = binary ? new Uint8Array(bytes) : bytes.toString("utf8");
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(frame);
    } else {
      frames.push(frame);
    }
  });
  socket.once("close", () => fail());
  socket.once("error", (error) =>
    fail(a2aError("transport_lost", "A2A WebSocket transport lost", error)),
  );
  const abort = () => {
    socket.close(1001, "scope_exit");
    fail();
  };
  signal.addEventListener("abort", abort, { once: true });

  return {
    *send(frame): Operation<void> {
      if (terminal || socket.readyState !== WebSocket.OPEN) {
        throw terminal ?? transportLost();
      }
      const size = typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
      if (size > A2A_MAX_FRAME_BYTES) {
        throw a2aError("payload_too_large", "A2A frame exceeds 2 MiB");
      }
      try {
        yield* call(
          () =>
            new Promise<void>((resolve, reject) =>
              socket.send(frame, (error) => (error ? reject(error) : resolve())),
            ),
        );
      } catch (error) {
        throw a2aError("transport_lost", "A2A WebSocket send failed", error);
      }
    },
    *receive(): Operation<string | Uint8Array> {
      const frame = frames.shift();
      if (frame !== undefined) {
        return frame;
      }
      if (terminal) {
        throw terminal;
      }
      return yield* call(
        () =>
          new Promise<string | Uint8Array>((resolve, reject) => waiters.push({ resolve, reject })),
      );
    },
    *close(code = 1000, reason = "scope_exit"): Operation<void> {
      signal.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      yield* call(
        () =>
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.close(code, reason.slice(0, 123));
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
            }
          }),
      );
    },
  };
}

function opened(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpected);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onUnexpected = (_request: unknown, response: { statusCode?: number }) => {
      cleanup();
      reject(
        a2aError(
          response.statusCode === 403 ? "authorization_denied" : "authentication_failed",
          "A2A WebSocket upgrade was rejected",
        ),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(transportLost());
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpected);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  return ((
    _hostname: string,
    lookupOptions: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    const records = addresses.map((address) => ({ address, family: isIP(address) }));
    if (lookupOptions?.all) {
      callback(null, records);
    } else {
      callback(null, records[0]?.address, records[0]?.family);
    }
  }) as LookupFunction;
}
function validateHeaders(headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (
      ["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-protocol"].includes(
        name.toLowerCase(),
      )
    ) {
      throw a2aError("authentication_failed", `Authorization provider may not set ${name}`);
    }
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw a2aError("authentication_failed", "Invalid WebSocket authorization header");
    }
  }
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
function transportLost(): CrankError {
  return a2aError("transport_lost", "A2A WebSocket transport lost");
}
