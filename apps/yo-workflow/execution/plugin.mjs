import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { resolve } from "node:path";

/** Dev-only endpoint: evaluator artifacts and the journal stay on the Node host. */
export function executionPlayground() {
    return {
        name: "workflow-execution-playground",
        configureServer(server) {
            let service;
            server.middlewares.use(async (request, response, next) => {
                const url = new URL(request.url ?? "/", "http://localhost");
                if (url.pathname !== "/api/execution") return next();
                response.setHeader("Content-Type", "application/json");
                response.setHeader("Cache-Control", "no-store");
                try {
                    if (
                        request.headers.origin &&
                        new URL(request.headers.origin).host !== request.headers.host
                    )
                        throw Error("Execution inspector requires a same-origin request");
                    if (!service) {
                        const module = require(
                            resolve(server.config.root, "execution/service.mjs"),
                        );
                        service = module.createExecutionService();
                    }
                    let result;
                    if (request.method === "GET") result = service.get(url.searchParams.get("id"));
                    else if (request.method === "POST") {
                        if (!request.headers["content-type"]?.startsWith("application/json"))
                            throw Error("Expected JSON request");
                        const chunks = [];
                        let size = 0;
                        for await (const chunk of request) {
                            size += chunk.length;
                            if (size > 16384) throw Error("Request too large");
                            chunks.push(chunk);
                        }
                        const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        if (
                            !command ||
                            !["start", "reply", "restore", "cancel"].includes(command.action)
                        )
                            throw Error("Invalid command");
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
