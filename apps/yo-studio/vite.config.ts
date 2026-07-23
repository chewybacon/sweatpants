import react from "@vitejs/plugin-react";
import { createScope } from "effection";
import { nodeRequestToWebRequest, sendWebResponse } from "@sweatpants/stream-bridge";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import {
  createStudioDevelopmentApi,
  createStudioDevelopmentRuntime,
} from "./src/server/development-api.ts";
import { createStudioDurableChatApplication } from "./src/server/durable-chat-application.ts";

function studioApi(): Plugin {
  return {
    name: "yo-studio-development-api",
    async configureServer(server) {
      const [scope, destroy] = createScope();
      const runtime = await scope.run(function* () {
        return yield* createStudioDevelopmentRuntime(process.cwd());
      });
      const api = createStudioDevelopmentApi(runtime);
      const chat = createStudioDurableChatApplication(runtime);

      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://yo-studio").pathname;
        if (pathname.startsWith("/api/chat")) {
          const webRequest = nodeRequestToWebRequest(request, "http://127.0.0.1:8100");
          chat
            .handle(webRequest)
            .then((webResponse) => sendWebResponse(response, webResponse))
            .catch((error) => {
              if (!response.headersSent) {
                response.statusCode = 500;
                response.end(error instanceof Error ? error.message : String(error));
              }
            });
          return;
        }
        scope
          .run(function* () {
            yield* api.handle(request, response, next);
          })
          .catch((error) => {
            if (!response.headersSent) {
              response.statusCode = 500;
              response.end(error instanceof Error ? error.message : String(error));
            }
          });
      });
      server.httpServer?.once("close", () => {
        void chat.close().then(() => destroy());
      });
    },
  };
}

export default defineConfig({
  plugins: [tsconfigPaths(), react(), studioApi()],
  server: { port: 8_100 },
});
