import { SchemeEvaluationPort } from "@sweatpants/scheme-runtime";
import { createNodeSchemeDriver } from "@sweatpants/scheme-runtime/node";
import { createServer } from "node:http";
import { chatStorageFromEnv, inProcess } from "@sweatpants/agent-host/server";
import { pi, createPiAiDecisionProvider } from "@sweatpants/model-provider-pi-ai";
import { nodeRequestToWebRequest, sendWebResponse } from "@sweatpants/stream-bridge";
import { createWorkflowApp } from "./application.ts";
import { TisynEvaluationPort } from "../workflow/evaluation/port.ts";
import { createNodeEvaluationDriver } from "../workflow/evaluation/node.ts";
import { reasoningLevel } from "./model-settings.ts";

const app = createWorkflowApp({
  workflowLanguage: "scheme",
  decisionProvider: createPiAiDecisionProvider(),
  execution: inProcess({
    *setup() {
      yield* SchemeEvaluationPort.installDriver(createNodeSchemeDriver());
      yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
    },
  }),
  storage: chatStorageFromEnv({ defaultPath: new URL("../../.data/chat.sqlite", import.meta.url) }),
  model: pi({
    provider: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
    model: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-sonnet-5.5",
    streamOptions: { thinking: reasoningLevel(process.env["DEFAULT_CHAT_MODEL_THINKING"]) },
  }),
});
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  if (url === "/health") {
    response.end("yo-workflow");
    return;
  }
  if (!url.startsWith("/api/chat")) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  void app
    .handler(nodeRequestToWebRequest(request, "http://127.0.0.1:8102"))
    .then((result) => sendWebResponse(response, result))
    .catch((error: unknown) => {
      console.error("[yo-workflow] request failed", error);
      if (!response.headersSent) {
        response.statusCode = 500;
      }
      response.end("yo-workflow request failed; see server log");
    });
});
server.listen(8102, "127.0.0.1", () => console.log("yo-workflow API: http://127.0.0.1:8102"));
let closing = false;
async function close() {
  if (closing) {
    return;
  }
  closing = true;
  server.close();
  await app.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().catch((error: unknown) => {
      console.error("[yo-workflow] shutdown failed", error);
      process.exitCode = 1;
    });
  });
}
