// @vitest-environment node
import { createContext, ensure, suspend } from "effection";
import { createTool } from "@sweatpants/agent-sdk";
import type { ToolInvocationResource } from "@sweatpants/tool-session";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionAdapter } from "@sweatpants/tool-session/execution";
import { createMcpApp } from "../index.ts";

const secret = "mcp-application-test-secret-at-least-32-bytes";
const identity = createContext<string>("test-identity");
const execution: ToolExecutionAdapter = {
  prepare() {
    return {
      *createResources() {
        return {
          *create() {
            throw new Error("No tools registered");
          },
          *open() {
            return null;
          },
        };
      },
    };
  },
};
function discover(method = "server/discover", params: Record<string, unknown> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      /* CONDITIONAL-SPREAD: HTTP headers must omit absent "Mcp-Name"; undefined is not a header value. */
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

describe("MCP application ownership", () => {
  it("close releases an active invocation and settles a waiting response reader", async () => {
    let invocation: ToolInvocationResource | null = null;
    let waiting = 0;
    let disposed = 0;
    const tool = createTool("waiting")
      .description("Wait until shutdown")
      .parameters(z.object({}))
      .execute(function* () {
        return {};
      });
    const app = createMcpApp({
      name: "test",
      version: "1",
      secret,
      tools: [tool],
      execution: {
        prepare() {
          return {
            *createResources() {
              return {
                *create(request) {
                  invocation = {
                    id: request.invocationId,
                    toolName: tool.name,
                    elicitBindings: {},
                    projection: {
                      *events() {
                        return {
                          *next() {
                            waiting++;
                            yield* suspend();
                            return { done: true as const, value: undefined };
                          },
                        };
                      },
                    },
                    *resume() {},
                    *dispose() {
                      disposed++;
                    },
                  };
                  return invocation;
                },
                *open() {
                  return invocation;
                },
              };
            },
          };
        },
      },
      *authenticate() {
        return "alice";
      },
    });
    try {
      const response = await app.handler(
        discover("tools/call", { name: "waiting", arguments: {} }),
      );
      const read = response.body!.getReader().read();
      await vi.waitFor(() => expect(waiting).toBe(2));
      await app.close();
      expect(disposed).toBe(1);
      expect(new TextDecoder().decode((await read).value)).toContain('"error"');
    } finally {
      await app.close();
    }
  });

  it("initializes once on demand, inherits scoped authentication, and awaits cleanup", async () => {
    let setups = 0;
    let finalized = 0;
    const callers: string[] = [];
    const app = createMcpApp({
      name: "test",
      version: "1",
      secret,
      tools: [],
      execution,
      setup: {
        *application() {
          setups++;
          yield* identity.set("alice");
          yield* ensure(() => {
            finalized++;
          });
        },
      },
      *authenticate() {
        const caller = yield* identity.expect();
        callers.push(caller);
        return caller;
      },
    });
    expect(setups).toBe(0);
    try {
      const responses = await Promise.all([app.handler(discover()), app.handler(discover())]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(setups).toBe(1);
      expect(callers).toEqual(["alice", "alice"]);
      expect(finalized).toBe(0);
    } finally {
      await Promise.all([app.close(), app.close()]);
    }
    expect(finalized).toBe(1);
    await expect(app.handler(discover())).rejects.toThrow("McpApp is closed");
  });

  it("does not start resources when closed before first use", async () => {
    const setup = vi.fn(function* () {});
    const app = createMcpApp({
      name: "test",
      version: "1",
      secret,
      tools: [],
      execution,
      setup: { application: setup },
      *authenticate() {
        return "alice";
      },
    });
    await app.close();
    expect(setup).not.toHaveBeenCalled();
    await expect(app.handler(discover())).rejects.toThrow("McpApp is closed");
  });

  it("reports setup failure and releases partially installed resources", async () => {
    let finalized = false;
    const app = createMcpApp({
      name: "test",
      version: "1",
      secret,
      tools: [],
      execution,
      setup: {
        *application() {
          yield* ensure(() => {
            finalized = true;
          });
          throw new Error("setup defect");
        },
      },
      *authenticate() {
        return "alice";
      },
    });
    try {
      await expect(app.handler(discover())).rejects.toThrow("setup defect");
      expect(finalized).toBe(true);
      await expect(app.handler(discover())).rejects.toThrow("setup defect");
    } finally {
      await app.close();
    }
  });

  it("close interrupts pending setup and settles the waiting request", async () => {
    let started = false;
    let finalized = false;
    const app = createMcpApp({
      name: "test",
      version: "1",
      secret,
      tools: [],
      execution,
      setup: {
        *application() {
          yield* ensure(() => {
            finalized = true;
          });
          started = true;
          yield* suspend();
        },
      },
      *authenticate() {
        return "alice";
      },
    });
    const result = app.handler(discover()).then(
      () => "unexpected success",
      () => "cancelled",
    );
    await vi.waitFor(() => expect(started).toBe(true));
    await app.close();
    expect(await result).toBe("cancelled");
    expect(finalized).toBe(true);
  });
});
