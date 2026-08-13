import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { call } from "effection";
import { describe, expect, it } from "vitest";
import {
  withTestScenario,
  type TestApplication,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import { connectRemoteStandardAgent, connectStandardAgent } from "./lib/a2a-scenario.ts";
import {
  ACCEPTANCE_AGENT_MODEL_ID,
  createAcceptanceStandardAgent,
} from "./fixtures/acceptance-standard-agent.ts";

type Binding = TestRigOptions["binding"];
type AgentPosture = "assembled-handle" | "remote-http";

function nodeRequest(incoming: IncomingMessage, origin: string, body: Uint8Array): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return new Request(new URL(incoming.url ?? "/", origin), {
    method: incoming.method ?? "GET",
    headers,
    ...(body.byteLength > 0 ? { body: Buffer.from(body).toString("utf8") } : {}),
  });
}

function readBody(incoming: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => resolve(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

function createNetworkHostedAgent(
  context: TestApplicationFactoryContext,
  ready: (origin: Promise<string>) => void,
): TestApplication {
  const application = createAcceptanceStandardAgent(context);
  const server = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("remote A2A server is not listening");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const response = await application.handle(
        nodeRequest(incoming, origin, await readBody(incoming)),
      );
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  ready(
    once(server, "listening").then(() => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("remote A2A server did not bind an ephemeral port");
      }
      return `http://127.0.0.1:${address.port}`;
    }),
  );
  return {
    // The rig application boundary remains available for diagnostics, but the
    // remote posture below deliberately bypasses it and uses the socket origin.
    handle: application.handle,
    async close() {
      await application.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function invokeStandardAgent(binding: Binding, posture: AgentPosture): Promise<void> {
  let remoteOrigin: Promise<string> | undefined;
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_AGENT_MODEL_ID,
      createApplication(context) {
        return posture === "remote-http"
          ? createNetworkHostedAgent(context, (origin) => {
              remoteOrigin = origin;
            })
          : createAcceptanceStandardAgent(context);
      },
    },
    function* (s) {
      let agent;
      if (posture === "remote-http") {
        const origin = yield* call(() => {
          if (!remoteOrigin) {
            throw new Error("remote A2A origin was not installed");
          }
          return remoteOrigin;
        });
        agent = yield* connectRemoteStandardAgent(s, origin);
      } else {
        agent = yield* connectStandardAgent(s);
      }
      expect(agent.card).toMatchObject({ name: "acceptance-standard-agent", version: "1" });

      const turn = yield* agent.send({
        messageId: `a2a-acceptance-${posture}-1`,
        role: "user",
        parts: [{ text: `A2A_ACCEPTANCE_QUESTION_V1:${posture}` }],
      });
      const sample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(
          `A2A_ACCEPTANCE_QUESTION_V1:${posture}`,
        );
      });
      yield* sample.respond.text(`A2A_ACCEPTANCE_ANSWER_V1:${posture}`);

      const result = yield* turn.complete();
      expect(result.type).toBe("task");
      if (result.type !== "task") {
        throw new Error("expected an A2A task result");
      }
      expect(result.task.status.state).toBe("completed");
      expect(JSON.stringify(result.task.history)).toContain(`A2A_ACCEPTANCE_ANSWER_V1:${posture}`);
    },
  );
}

describe("standard A2A agent posture matrix", () => {
  it("discovers and completes an assembled handle in-process", async () => {
    await invokeStandardAgent("in-process", "assembled-handle");
  }, 30_000);

  it("discovers and completes a remote agent over HTTP", async () => {
    await invokeStandardAgent("http", "remote-http");
  }, 30_000);
});
