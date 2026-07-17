import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createDurableToolRegistry } from "@sweatpants/session-contract";
import { DURABLE_DRIVER_FIXTURE_TOOLS } from "@sweatpants/session-contract/testing";
import {
  A2A_EXTENSIONS_HEADER,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  bindA2AExecutorWebSocket,
  createA2AProgramDriver,
  createA2AProgramExecutor,
  createNodeA2AWebSocketConnector,
  parseActivatedA2AExtensions,
} from "../index.ts";

const servers: Array<{ http: Server; ws: WebSocketServer }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.ws.clients) client.terminate();
    await Promise.all([
      new Promise<void>((resolve) => server.ws.close(() => resolve())),
      new Promise<void>((resolve) => server.http.close(() => resolve())),
    ]);
  }
});

async function startExecutorServer() {
  const registry = createDurableToolRegistry(DURABLE_DRIVER_FIXTURE_TOOLS);
  const executor = createA2AProgramExecutor({
    executorId: "ws-reference-executor",
    computeGeneration: "ws-generation-1",
    registry,
  });
  const http = createServer();
  const ws = new WebSocketServer({ server: http, maxPayload: 2 * 1024 * 1024 });
  ws.on("connection", (socket, request) => {
    if (request.headers.authorization !== "Bearer test-token") {
      socket.close(1008, "authentication_failed");
      return;
    }
    bindA2AExecutorWebSocket(socket, {
      executor,
      principal: { principalId: "ws-caller" },
      activatedExtensions: parseActivatedA2AExtensions(
        request.headers[A2A_EXTENSIONS_HEADER.toLowerCase()],
      ),
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  servers.push({ http, ws });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  return { endpoint: `ws://127.0.0.1:${address.port}`, registry, executor };
}

describe("real A2A WebSocket binding", () => {
  it("negotiates, attaches, steps idempotently, and shuts down over a real socket", async () => {
    const { endpoint, registry, executor } = await startExecutorServer();
    const tool = DURABLE_DRIVER_FIXTURE_TOOLS[0]!;
    const driver = createA2AProgramDriver({
      connector: createNodeA2AWebSocketConnector({
        urlPolicy: { allowLocalhostTests: true },
        authorization: () => ({ headers: { authorization: "Bearer test-token" } }),
      }),
      manifest: async () => tool.manifest,
    });
    const request = {
      sessionId: "ws-session",
      taskId: "ws-task",
      program: {
        id: tool.manifest.programId,
        version: tool.manifest.version,
        digest: tool.manifest.digest,
      },
      input: "hello",
      route: {
        driverKind: "a2a",
        protocolVersion: 1,
        extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
        executionId: "ws-execution",
        driverEndpoint: endpoint,
        cardOrigin: endpoint.replace("ws:", "http:"),
      },
      executionEpoch: 1,
    } as const;
    await run(function* () {
      const attachment = yield* driver.attach(request);
      const first = yield* driver.step(attachment, { type: "start", input: "hello" });
      const duplicate = yield* driver.step(attachment, { type: "start", input: "hello" });
      expect(duplicate).toEqual(first);
      yield* driver.shutdown(attachment, "parked");
    });
    expect(executor.activeAttachmentCount()).toBe(0);
    expect(registry.size).toBeGreaterThan(0);
  });

  it("closes malformed and oversized real frames with protocol close codes", async () => {
    const { endpoint } = await startExecutorServer();
    const connect = () =>
      new WebSocket(endpoint, {
        headers: {
          authorization: "Bearer test-token",
          [A2A_EXTENSIONS_HEADER]: CALLER_AUTHORITATIVE_EXTENSION_URI,
        },
      });

    const malformed = connect();
    const malformedHello = once(malformed, "message");
    await once(malformed, "open");
    await malformedHello;
    malformed.send('{"not":"canonical", "spacing":true}');
    const [malformedCode] = (await once(malformed, "close")) as [number, Buffer];
    expect(malformedCode).toBe(1002);

    const oversized = connect();
    const oversizedHello = once(oversized, "message");
    await once(oversized, "open");
    await oversizedHello;
    oversized.send("x".repeat(2 * 1024 * 1024 + 1));
    const [oversizedCode] = (await once(oversized, "close")) as [number, Buffer];
    expect(oversizedCode).toBe(1009);
  });
});
