import { LuaEvaluationPort } from "../workflow/lua/evaluation.ts";
import { invokeWasm } from "../../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm-node.mts";
import { workflowLanguage, type WorkflowLanguage } from "../workflow/language.ts";
import { SchemeEvaluationPort } from "@sweatpants/scheme-runtime";
import { createNodeSchemeDriver } from "@sweatpants/scheme-runtime/node";
import { createServer } from "node:http";
import { chatStorageFromEnv, inProcess } from "@sweatpants/agent-host/server";
import { pi, createPiAiDecisionProvider } from "@sweatpants/model-provider-pi-ai";
import { nodeRequestToWebRequest, sendWebResponse } from "@sweatpants/stream-bridge";
import { createWorkflowApp } from "./application.ts";
import { reasoningLevel } from "./model-settings.ts";

const apps = new Map<WorkflowLanguage, ReturnType<typeof createWorkflowApp>>();
function application(language: WorkflowLanguage) {
  const existing = apps.get(language);
  if (existing) {
    return existing;
  }
  const app = createWorkflowApp({
    language,
    decisionProvider: createPiAiDecisionProvider(),
    execution: inProcess({
      *setup() {
        yield* LuaEvaluationPort.installDriver({ execute: invokeWasm });
        yield* SchemeEvaluationPort.installDriver(createNodeSchemeDriver());
      },
    }),
    storage: chatStorageFromEnv({
      defaultPath: new URL("../../.data/chat.sqlite", import.meta.url),
    }),
    model: pi({
      provider: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
      model: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-sonnet-5.5",
      streamOptions: { thinking: reasoningLevel(process.env["DEFAULT_CHAT_MODEL_THINKING"]) },
    }),
  });
  apps.set(language, app);
  return app;
}
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
  let language: WorkflowLanguage;
  try {
    language = workflowLanguage(
      typeof request.headers["x-workflow-language"] === "string"
        ? request.headers["x-workflow-language"]
        : null,
    );
  } catch (error) {
    // Invalid client selection is an observable HTTP error, not a process crash.
    response.statusCode = 400;
    response.end(String(error));
    return;
  }
  void application(language)
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
  await Promise.all([...apps.values()].map((app) => app.close()));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().catch((error: unknown) => {
      console.error("[yo-workflow] shutdown failed", error);
      process.exitCode = 1;
    });
  });
}
