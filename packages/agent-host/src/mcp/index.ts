import { createScope, suspend, useAbortSignal, type Operation } from "effection";
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpHandlerOptions,
} from "@sweatpants/tool-session/mcp";
import {
  createToolInvocationHost,
  ToolInvocationHostPort,
  ToolInvocationEventSourcePort,
} from "@sweatpants/tool-session";
import type { ToolExecutionAdapter } from "@sweatpants/tool-session/execution";

export type { McpFormAdapter, McpFormAdapters } from "@sweatpants/tool-session/mcp";

export interface McpAppConfig extends McpHandlerOptions {
  execution: ToolExecutionAdapter;
  setup?: {
    application?: (context: { signal: AbortSignal }) => Operation<void>;
  };
}

export interface McpApp {
  readonly handler: (request: Request) => Promise<Response>;
  close(): Promise<void>;
}

/** A lazy MCP application. Owns setup, runtime resources and response lifetimes. */
export function createMcpApp(config: McpAppConfig): McpApp {
  const { execution, setup, ...options } = config;
  const names = new Set<string>();
  for (const tool of options.tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }
    names.add(tool.name);
    if (tool.execution === "crank_native") {
      throw new Error(
        "McpApp requires invocation tools; durable programs require a journal-backed host",
      );
    }
  }
  const prepared = execution.prepare(options.tools, "tools");
  const { createResources } = prepared;
  if (!createResources) {
    throw new Error("MCP execution adapter must provide invocation resources");
  }

  let ready: Promise<McpHttpHandler> | undefined;
  let destroy: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let failed: { error: unknown } | undefined;

  const initialize = () => {
    if (!ready) {
      const [scope, dispose] = createScope();
      destroy = async () => {
        await dispose();
      };
      ready = new Promise((resolve, reject) => {
        scope
          .run(function* () {
            const signal = yield* useAbortSignal();
            if (setup?.application) {
              yield* setup.application({ signal });
            }
            if (prepared.setup) {
              yield* prepared.setup();
            }
            const factory = yield* createResources();
            yield* ToolInvocationHostPort.installDriver(
              createToolInvocationHost({ driver: factory }),
            );
            yield* ToolInvocationEventSourcePort.installDriver({
              *open(id) {
                return (yield* factory.open(id))?.projection ?? null;
              },
            });
            const { handler } = yield* createMcpHandler(options);
            resolve(handler);
            yield* suspend();
          })
          .catch((error: unknown) => {
            // Setup and supervised runtime failures remain observable to callers.
            failed = { error };
            reject(error);
          });
      });
    }
    return ready;
  };

  return {
    async handler(request) {
      if (closed) {
        throw new Error("McpApp is closed");
      }
      if (failed) {
        throw failed.error;
      }
      const handler = await initialize();
      if (closed) {
        throw new Error("McpApp is closed");
      }
      return handler(request);
    },
    close() {
      closed = true;
      return (closing ??= destroy?.() ?? Promise.resolve());
    },
  };
}
