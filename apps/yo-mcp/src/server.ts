import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { run } from "effection";
import { createMcpHandler } from "@sweatpants/tool-session/mcp";
import type { SampleResultBase } from "@sweatpants/agent-sdk";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import {
  createInMemoryToolSessionStore,
  createToolInvocationHost,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";
import { createToolsMap } from "./tools/index.js";

const TOOL_WORKER_URL = new URL("./tool-worker.mjs", import.meta.url);
const TOOL_WORKER_EXEC_ARGV = ["--conditions=development", "--import", "tsx"];

function createMockSamplingProvider(): ToolSessionSamplingProvider {
  return {
    *sample(_messages, options) {
      const maxTokens = options?.maxTokens ?? 100;
      return {
        text: `[Mock LLM response - would generate up to ${maxTokens} tokens]`,
        model: "mock-model",
        stopReason: "endTurn",
      } as SampleResultBase;
    },
  };
}

export async function createYoMcpRuntime() {
  return await run(function* () {
    const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
      worker: { workerUrl: TOOL_WORKER_URL, isDev: false, execArgv: TOOL_WORKER_EXEC_ARGV },
    });
    const { handler, manager } = createMcpHandler({
      registry,
      host: createToolInvocationHost(registry),
      tools: createToolsMap(),
      sessionTimeout: 300_000,
      sseRetryMs: 1_000,
    });
    return {
      handler,
      cleanup: async () => {
        await run(function* () {
          yield* manager.cleanup();
        });
      },
    };
  });
}

export async function startYoMcpServer(port = 3_001) {
  const runtime = await createYoMcpRuntime();
  const server = await startNodeServer(runtime.handler, port);
  return {
    origin: server.origin,
    async close() {
      await runtime.cleanup();
      await closeServer(server.server);
    },
  };
}

async function startNodeServer(
  handler: (request: Request) => Promise<Response>,
  port: number,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("Access-Control-Allow-Origin", "*");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    outgoing.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Accept",
    );
    outgoing.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (incoming.method === "OPTIONS") {
      outgoing.statusCode = 204;
      outgoing.end();
      return;
    }

    try {
      const url = new URL(incoming.url || "/", `http://localhost:${port}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      let body: string | undefined;
      if (incoming.method === "POST") {
        body = await new Promise<string>((resolve, reject) => {
          let data = "";
          incoming.on("data", (chunk) => (data += chunk));
          incoming.on("end", () => resolve(data));
          incoming.on("error", reject);
        });
      }
      const response = await handler(
        new Request(url, {
          method: incoming.method || "GET",
          headers,
          ...(body !== undefined ? { body } : {}),
        }),
      );
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      if (!response.body) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        outgoing.write(next.value);
      }
      outgoing.end();
    } catch (error) {
      console.error("Request error:", error);
      outgoing.statusCode = 500;
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
