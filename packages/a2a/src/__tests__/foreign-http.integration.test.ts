import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "effection";
import {
  createHttpJsonForeignA2AClient,
  createSecureForeignA2AHttpTransport,
  type ForeignA2AInvocationPin,
} from "../index.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("secure foreign A2A HTTP+JSON transport", () => {
  it("pins localhost policy, preserves principal auth, and sends non-blocking HTTP+JSON", async () => {
    let received: unknown;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "content-type": "application/a2a+json" });
        response.end(
          JSON.stringify({
            task: {
              id: "task-http",
              contextId: "context-http",
              status: { state: "TASK_STATE_WORKING" },
              artifacts: [],
            },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP port");
    const origin = `http://127.0.0.1:${address.port}`;
    const transport = createSecureForeignA2AHttpTransport({
      cardOrigin: origin,
      urlPolicy: { allowLocalhostTests: true },
      authorization: (_url, principalId) => ({ authorization: `Bearer ${principalId}` }),
    });
    const client = createHttpJsonForeignA2AClient({ transport });
    const pin: ForeignA2AInvocationPin = {
      cardDigest: "a".repeat(64),
      agentName: "http-agent",
      skillId: "work",
      interface: { url: `${origin}/a2a`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      extensionUris: [],
      guarantee: {
        level: "task_handle_only",
        source: "base_task_handle",
        negotiatedAt: new Date().toISOString(),
      },
      ambiguityPolicy: "surface",
      invocationId: "inv-http",
      initialMessageId: "msg-http",
      requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      principalId: "principal-http",
    };
    const result = await run(() =>
      client.sendInitial({
        pin,
        message: { messageId: pin.initialMessageId, role: "user", parts: [{ text: "hello" }] },
      }),
    );
    expect(result).toMatchObject({ type: "task", task: { id: "task-http" } });
    expect(received).toMatchObject({
      method: "POST",
      url: "/a2a/message:send",
      authorization: "Bearer principal-http",
      body: { configuration: { returnImmediately: true } },
    });
  });
});
