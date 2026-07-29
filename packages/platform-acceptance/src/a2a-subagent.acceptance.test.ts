import { type DurableToolRegistry } from "@sweatpants/durable-execution";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { call, race } from "effection";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  A2A_EXTENSIONS_HEADER,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  bindA2AExecutorWebSocket,
  createA2AProgramDriver,
  createA2AProgramExecutor,
  createNodeA2AWebSocketConnector,
  parseActivatedA2AExtensions,
} from "@sweatpants/a2a";
import { createRegistryManifestProvider } from "@sweatpants/a2a/testing";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import type { ProgramDriver } from "@sweatpants/durable-execution";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_TOOL_RESULT_MARKER,
  acceptanceDurableTool,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];
type Posture = "mounted-code-handle" | "a2a-websocket";

interface A2AServer {
  endpoint: string;
  close(): Promise<void>;
}

async function startExecutorServer(registry: DurableToolRegistry): Promise<A2AServer> {
  const executor = createA2AProgramExecutor({
    executorId: "acceptance-networked-subagent-executor",
    computeGeneration: "acceptance-networked-generation-1",
    registry,
  });
  const http: Server = createServer();
  const ws = new WebSocketServer({ server: http, maxPayload: 2 * 1024 * 1024 });
  ws.on("connection", (socket, request) => {
    bindA2AExecutorWebSocket(socket, {
      executor,
      principal: { principalId: "framework-acceptance-caller" },
      activatedExtensions: parseActivatedA2AExtensions(
        request.headers[A2A_EXTENSIONS_HEADER.toLowerCase()],
      ),
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("A2A acceptance executor did not bind an ephemeral port");
  }
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of ws.clients) {
        client.terminate();
      }
      await Promise.all([
        new Promise<void>((resolve) => ws.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
    },
  };
}

async function invokeStructuredChild(binding: Binding, posture: Posture): Promise<void> {
  let server: A2AServer | undefined;
  try {
    await withTestScenario(
      {
        binding,
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication(context) {
          if (posture === "mounted-code-handle") {
            // Plain code composition: the authored durable child handle is
            // mounted directly and uses the application's normal packaged
            // worker driver. No A2A card or protocol object is involved.
            return createAcceptanceApplication(context);
          }
          return createAcceptanceApplication(context, undefined, {
            durableDriverKind: "a2a",
            durableRoute: {
              driverKind: "a2a",
              protocolVersion: 1,
              extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
              executionId: "acceptance-networked-subagent-execution",
              // Replaced at attach after the ephemeral server has bound.
              driverEndpoint: "ws://127.0.0.1:1",
              cardOrigin: "http://127.0.0.1",
            },
            createDurableDriver(registry): ProgramDriver {
              // The application factory is synchronous, but binding a socket is
              // asynchronous. Defer endpoint resolution until attach by wrapping
              // the network driver after the server promise resolves.
              const ready = startExecutorServer(registry).then((started) => {
                server = started;
                return started;
              });
              const network = createA2AProgramDriver({
                connector: createNodeA2AWebSocketConnector({
                  urlPolicy: { allowLocalhostTests: true },
                }),
                manifest: createRegistryManifestProvider(registry),
              });
              return {
                capabilities: network.capabilities,
                *attach(request) {
                  const started = yield* call(() => ready);
                  return yield* network.attach({
                    ...request,
                    route: {
                      driverKind: "a2a",
                      protocolVersion: 1,
                      extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
                      executionId: "acceptance-networked-subagent-execution",
                      driverEndpoint: started.endpoint,
                      cardOrigin: started.endpoint.replace("ws:", "http:"),
                    },
                  });
                },
                *step(attachment, command) {
                  return yield* network.step(attachment, command);
                },
                *shutdown(attachment, reason) {
                  return yield* network.shutdown(attachment, reason);
                },
                ...(network.manifest ? { manifest: network.manifest } : {}),
              };
            },
          });
        },
        scenarioTimeoutMs: 30_000,
      },
      function* (s) {
        const conversation = s.conversation({ tools: [acceptanceDurableTool] });
        const turn = yield* conversation.send(`Delegate train selection using ${posture}`);
        const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* outer.respond.toolCalls([
          {
            id: `${posture}-subagent-call-1`,
            name: ACCEPTANCE_DURABLE_TOOL_NAME,
            arguments: { topic: posture },
          },
        ]);

        const nested = yield* race([
          s.model.request((request) => {
            expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
          }),
          (function* () {
            const failure = yield* turn.failure();
            throw new Error(`${posture} child failed before nested sampling: ${failure.message}`);
          })(),
        ]);
        yield* nested.respond.text(`${posture} child recommends the express`);

        const choice = yield* turn.elicit("chooseOption");
        expect(choice.context).toMatchObject({
          options: [`${posture}-alpha`, `${posture}-beta`],
        });
        yield* choice.accept({ selected: `${posture}-beta` });

        const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        const input = JSON.stringify(final.body.input);
        expect(input).toContain(`${posture}-subagent-call-1`);
        expect(input).toContain(DURABLE_TOOL_RESULT_MARKER);
        expect(input).toContain(`${posture}-beta`);
        yield* final.respond.text(`${posture} sub-agent completed.`);
        expect((yield* turn.settled()).text).toBe(`${posture} sub-agent completed.`);
      },
    );
  } finally {
    await server?.close();
  }
}

describe.each<Binding>(["in-process", "http"])(
  "sub-agent composition through the %s chat binding",
  (binding) => {
    it.each<Posture>(["mounted-code-handle", "a2a-websocket"])(
      "preserves sample, elicit, replay, and result semantics in the %s posture",
      async (posture) => {
        await invokeStructuredChild(binding, posture);
      },
      30_000,
    );
  },
);
