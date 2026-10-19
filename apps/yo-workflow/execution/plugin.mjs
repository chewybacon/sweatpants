import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { tsImport } = require("tsx/esm/api");
import { resolve } from "node:path";

/** Dev-only endpoint: evaluator artifacts and the journal stay on the Node host. */
export function executionPlayground() {
  return {
    name: "workflow-execution-playground",
    configureServer(server) {
      let servicePromise;
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/api/execution") {
          return next();
        }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        try {
          if (
            request.headers.origin &&
            new URL(request.headers.origin).host !== request.headers.host
          ) {
            throw Error("Execution inspector requires a same-origin request");
          }
          if (!servicePromise) {
            servicePromise = (async () => {
              const module = await tsImport(
                resolve(server.config.root, "execution/service.mjs"),
                import.meta.url,
              );
              return module.createExecutionService({
                async author(prompt, language) {
                  const { authorLocalCaller } = await tsImport(
                    resolve(server.config.root, "execution/node-author.mts"),
                    import.meta.url,
                  );
                  return authorLocalCaller(
                    prompt,
                    (source) => module.validateCaller(source, language),
                    await module.authoring(language),
                  );
                },
              });
            })();
          }
          const service = await servicePromise;
          let result;
          if (request.method === "GET") {
            result = url.searchParams.has("id")
              ? await service.get(url.searchParams.get("id"))
              : { languages: service.languages };
          } else if (request.method === "POST") {
            if (!request.headers["content-type"]?.startsWith("application/json")) {
              throw Error("Expected JSON request");
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
              size += chunk.length;
              if (size > 16384) {
                throw Error("Request too large");
              }
              chunks.push(chunk);
            }
            const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!command || !["start", "reply", "restore", "cancel"].includes(command.action)) {
              throw Error("Invalid command");
            }
            result = await service.command(command);
          } else {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }
          response.end(JSON.stringify(result));
        } catch (error) {
          // HTTP error is visible to the inspector; no silent fallback to another engine.
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    },
  };
}
