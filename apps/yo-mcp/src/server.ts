import { createMcpApp } from "@sweatpants/agent-host/mcp";
import { serve } from "@sweatpants/agent-host/node";
import { local } from "@sweatpants/tool-runtime-local";
import { allTools } from "./tools/index.js";

export function createYoMcpApp() {
  return createMcpApp({
    name: "yo-mcp",
    version: "0.1.0",
    secret: "yo-mcp-local-development-continuation-secret",
    tools: allTools,
    execution: local({
      worker: new URL("./tool-worker.mjs", import.meta.url),
      isDev: false,
      execArgv: ["--conditions=development", "--import", "tsx"],
    }),
    *authenticate() {
      return "local-demo";
    },
  });
}

export function startYoMcpServer(port = 3_001) {
  return serve(createYoMcpApp(), {
    port,
    middleware: [
      async (request, next) => {
        // Local Inspector demo policy; authentication and trusted origins belong to the app.
        const response =
          request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await next();
        response.headers.set("Access-Control-Allow-Origin", "*");
        response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        response.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Accept",
        );
        return response;
      },
    ],
  });
}
