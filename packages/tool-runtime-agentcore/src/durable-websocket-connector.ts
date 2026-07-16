import { createHash, createHmac } from "node:crypto";

import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { call, type Operation } from "effection";
import { WebSocket, type RawData } from "ws";

import { CrankError, type AgentCoreRuntimeRelease } from "@sweatpants/session-contract";
import { AGENTCORE_MAX_FRAME_BYTES } from "./durable-protocol.ts";

export interface AgentCoreWebSocketConnectRequest {
  readonly release: AgentCoreRuntimeRelease;
  readonly runtimeSessionId: string;
  readonly signal: AbortSignal;
}

export interface AgentCoreWebSocketConnection {
  send(frame: string | Uint8Array): Operation<void>;
  receive(): Operation<string | Uint8Array>;
  close(code?: number, reason?: string): Operation<void>;
}

export interface AgentCoreWebSocketConnector {
  connect(request: AgentCoreWebSocketConnectRequest): Operation<AgentCoreWebSocketConnection>;
  stopRuntimeSession?(request: {
    release: AgentCoreRuntimeRelease;
    runtimeSessionId: string;
    signal: AbortSignal;
  }): Operation<"stopped" | "already_stopped">;
}

export interface SigV4AgentCoreWebSocketConnectorOptions {
  readonly credentials?: ReturnType<typeof defaultProvider>;
  readonly endpointForRelease?: (release: AgentCoreRuntimeRelease) => URL;
  readonly webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

/** Default TLS connector. SigV4 credentials remain in headers, never URL query parameters. */
export function createSigV4AgentCoreWebSocketConnector(
  options: SigV4AgentCoreWebSocketConnectorOptions = {},
): AgentCoreWebSocketConnector {
  const credentials = options.credentials ?? defaultProvider();
  const endpointForRelease = options.endpointForRelease ?? defaultEndpoint;
  const webSocketFactory =
    options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));

  return {
    *connect(request): Operation<AgentCoreWebSocketConnection> {
      if (request.signal.aborted) throw transportLost();
      const endpoint = endpointForRelease(request.release);
      if (endpoint.protocol !== "wss:")
        throw new CrankError("placement_unavailable", "AgentCore WebSocket must use TLS");
      const signer = new SignatureV4({
        credentials,
        region: request.release.region,
        service: "bedrock-agentcore",
        sha256: NodeSha256,
      });
      let signed: { headers: Record<string, string> };
      try {
        const unsigned = new HttpRequest({
          protocol: "https:",
          hostname: endpoint.hostname,
          ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
          method: "GET",
          path: endpoint.pathname,
          query: {},
          headers: {
            host: endpoint.host,
            "x-amzn-bedrock-agentcore-runtime-session-id": request.runtimeSessionId,
          },
        });
        // Smithy 5's signer accepts the same structural request while its public
        // type is sourced from @smithy/core rather than protocol-http.
        const signRequest = signer.sign.bind(signer) as unknown as (
          request: HttpRequest,
        ) => Promise<{ headers: Record<string, string> }>;
        signed = yield* call(() => signRequest(unsigned));
      } catch (error) {
        throw new CrankError(
          "agentcore_auth_failed",
          "AgentCore handshake signing failed",
          undefined,
          { cause: error },
        );
      }
      const socket = webSocketFactory(endpoint.toString(), {
        headers: signed.headers,
        maxPayload: AGENTCORE_MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
      try {
        yield* call(() => opened(socket, request.signal));
      } catch (error) {
        socket.terminate();
        if (request.signal.aborted) throw transportLost();
        throw new CrankError(
          "agentcore_auth_failed",
          "AgentCore WebSocket handshake failed",
          undefined,
          { cause: error },
        );
      }
      return createConnection(socket, request.signal);
    },
    *stopRuntimeSession(request): Operation<"stopped" | "already_stopped"> {
      if (request.signal.aborted) throw transportLost();
      const client = new BedrockAgentCoreClient({
        region: request.release.region,
        credentials,
      });
      try {
        yield* call(() =>
          client.send(
            new StopRuntimeSessionCommand({
              agentRuntimeArn: request.release.runtimeArn,
              runtimeSessionId: request.runtimeSessionId,
            }),
            { abortSignal: request.signal },
          ),
        );
        return "stopped";
      } catch (error) {
        const name =
          error && typeof error === "object" && "name" in error
            ? String((error as { name: unknown }).name)
            : "";
        if (name === "ResourceNotFoundException" || name === "ValidationException") {
          return "already_stopped";
        }
        throw new CrankError("placement_unavailable", "AgentCore session stop failed", undefined, {
          cause: error,
        });
      } finally {
        client.destroy();
      }
    },
  };
}

function defaultEndpoint(release: AgentCoreRuntimeRelease): URL {
  const arn = encodeURIComponent(release.runtimeArn);
  return new URL(`wss://bedrock-agentcore.${release.region}.amazonaws.com/runtimes/${arn}/ws`);
}

function createConnection(socket: WebSocket, signal: AbortSignal): AgentCoreWebSocketConnection {
  const frames: Array<string | Uint8Array> = [];
  const waiters: Array<{
    resolve: (frame: string | Uint8Array) => void;
    reject: (error: unknown) => void;
  }> = [];
  let terminal: CrankError | undefined;
  const fail = (error = transportLost()) => {
    terminal ??= error;
    for (const waiter of waiters.splice(0)) waiter.reject(terminal);
  };
  socket.on("message", (data: RawData, binary) => {
    const frame = binary ? new Uint8Array(asBuffer(data)) : asBuffer(data).toString("utf8");
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else frames.push(frame);
  });
  socket.once("close", () => fail());
  socket.once("error", (error) =>
    fail(
      new CrankError("agentcore_transport_lost", "AgentCore transport lost", undefined, {
        cause: error,
      }),
    ),
  );
  const abort = () => {
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    } else {
      socket.close(1001, "scope_exit");
    }
    fail();
  };
  signal.addEventListener("abort", abort, { once: true });

  return {
    *send(frame): Operation<void> {
      if (terminal || socket.readyState !== WebSocket.OPEN) throw terminal ?? transportLost();
      const size = typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
      if (size > AGENTCORE_MAX_FRAME_BYTES)
        throw new CrankError("payload_too_large", "AgentCore frame exceeds 2 MiB");
      yield* call(
        () =>
          new Promise<void>((resolve, reject) =>
            socket.send(frame, (error) => (error ? reject(error) : resolve())),
          ),
      );
    },
    *receive(): Operation<string | Uint8Array> {
      const frame = frames.shift();
      if (frame !== undefined) return frame;
      if (terminal) throw terminal;
      return yield* call(
        () =>
          new Promise<string | Uint8Array>((resolve, reject) => waiters.push({ resolve, reject })),
      );
    },
    *close(code = 1000, reason = "scope_exit"): Operation<void> {
      signal.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.CLOSED) return;
      yield* call(
        () =>
          new Promise<void>((resolve) => {
            const done = () => resolve();
            socket.once("close", done);
            socket.close(code, reason.slice(0, 123));
            if (socket.readyState === WebSocket.CLOSED) resolve();
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
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? transportLost());
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as unknown as ArrayBuffer);
}

function transportLost(): CrankError {
  return new CrankError("agentcore_transport_lost", "AgentCore transport lost");
}

class NodeSha256 {
  readonly #hash;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    const key =
      typeof secret === "string"
        ? secret
        : secret instanceof ArrayBuffer
          ? Buffer.from(secret)
          : secret
            ? Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
            : undefined;
    this.#hash = key ? createHmac("sha256", key) : createHash("sha256");
  }
  update(data: Uint8Array): void {
    this.#hash.update(data);
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.#hash.digest());
  }
}
