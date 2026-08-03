import react from "@vitejs/plugin-react";
import { createScope } from "effection";
import { nodeRequestToWebRequest, sendWebResponse } from "@sweatpants/stream-bridge";
import { createLambdaMicrovmWorkspaceManager } from "@sweatpants/workspace-lambda-microvm";
import { clientContractPlugin } from "@sweatpants/vite-plugin";
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
              imageArn: requiredEnvironment("YO_STUDIO_MICROVM_IMAGE_ARN"),
              imageVersion: codingSandbox.image.version,
              executionRoleArn: requiredEnvironment("YO_STUDIO_MICROVM_EXECUTION_ROLE_ARN"),
              ...(process.env["AWS_PROFILE"] ? { profile: process.env["AWS_PROFILE"] } : {}),
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
        })().catch((error: unknown) => {
          console.error(
            "[yo-studio] development runtime cleanup failed",
            error instanceof Error ? error.message : String(error),
          );
        });
      });
    },
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for AWS workspace placement`);
  }
  return value;
}

export default defineConfig({
  plugins: [clientContractPlugin(), tsconfigPaths(), react(), studioApi()],
  define: {
    __YO_STUDIO_WORKSPACE_PLACEMENT__: JSON.stringify(
      process.env["YO_STUDIO_WORKSPACE_PLACEMENT"] ?? "local",
    ),
  },
  server: { port: 8_100 },
});
