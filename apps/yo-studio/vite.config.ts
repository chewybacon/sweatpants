import react from "@vitejs/plugin-react";
import { createScope } from "effection";
import { nodeRequestToWebRequest, sendWebResponse } from "@sweatpants/stream-bridge";
import { createLambdaMicrovmWorkspaceManager } from "@sweatpants/sandbox-provider-aws";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import {
  createStudioDevelopmentApi,
  createStudioDevelopmentRuntime,
} from "./src/server/development-api.ts";
import { createStudioDurableChatApplication } from "./src/server/durable-chat-application.ts";
import { codingSandbox, productWorkspace } from "./src/deployment.ts";

function studioApi(): Plugin {
  return {
    name: "yo-studio-development-api",
    async configureServer(server) {
      const [scope, destroy] = createScope();
      const runtime = await scope.run(function* () {
        return yield* createStudioDevelopmentRuntime(process.cwd());
      });
      const api = createStudioDevelopmentApi(runtime);
      const placement = process.env["YO_STUDIO_WORKSPACE_PLACEMENT"] ?? "local";
      const awsManager =
        placement === "aws"
          ? createLambdaMicrovmWorkspaceManager({
              imageArn:
                process.env["YO_STUDIO_MICROVM_IMAGE_ARN"] ??
                "arn:aws:lambda:us-east-1:123456789012:microvm-image:sweatpants-durable-sandbox",
              imageVersion: codingSandbox.image.version,
              executionRoleArn:
                process.env["YO_STUDIO_MICROVM_EXECUTION_ROLE_ARN"] ??
                "arn:aws:iam::123456789012:role/sweatpants-microvm-exec-f9fdea17",
              profile: process.env["AWS_PROFILE"] ?? "default",
              region: process.env["AWS_REGION"] ?? "us-east-1",
              scripts: productWorkspace.scripts,
              idle: {
                warmSeconds: codingSandbox.lifecycle.warmIdleSeconds,
                suspendedSeconds: codingSandbox.lifecycle.suspendedLifetimeSeconds,
                maximumSeconds: codingSandbox.lifecycle.suspendedLifetimeSeconds,
              },
              logging: { logGroup: "/aws/lambda-microvms/sweatpants-durable-sandbox" },
            })
          : undefined;
      const chat = createStudioDurableChatApplication(
        awsManager
          ? {
              resolveWorkspace: function* (context) {
                return yield* awsManager.resolve(context);
              },
            }
          : runtime,
      );

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
        void (async () => {
          await chat.close();
          if (awsManager) {
            await scope.run(function* () {
              yield* awsManager.close();
            });
          }
          await destroy();
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [tsconfigPaths(), react(), studioApi()],
  define: {
    __YO_STUDIO_WORKSPACE_PLACEMENT__: JSON.stringify(
      process.env["YO_STUDIO_WORKSPACE_PLACEMENT"] ?? "local",
    ),
  },
  server: { port: 8_100 },
});
