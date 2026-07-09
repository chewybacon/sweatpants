/**
 * Golden-path acceptance suite (REQ-014).
 *
 * Imports ONLY product facade allowlisted paths:
 * - @sweatpants/framework/server
 * - @sweatpants/framework/chat
 * - @sweatpants/framework/chat/durable-streams
 * - @sweatpants/core
 *
 * Exercises: construct chat application, define a tool with createTool,
 * send a user message, complete a turn (with tool call).
 */
import { describe, expect, it } from "vitest";
import { call, resource, type Operation, type Subscription } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import {
  createChatApplication,
  createChatHandler,
} from "@sweatpants/framework/server";
import {
  ModelProviderContext,
  ModelProviderModelContext,
  ToolInventoryContext,
  ToolRuntimeContext,
  createToolInventory,
  createToolExecutionRef,
  validateToolParameters,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type ToolRuntime,
} from "@sweatpants/framework/chat";
import { setupInMemoryDurableStreams } from "@sweatpants/framework/chat/durable-streams";
import { eventsOfType, readDurableEvents } from "./ndjson.ts";

function mockModel(): Model {
  return {
    id: "mock-model",
    name: "Mock Model",
    api: "mock",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function createScriptedModelProvider(options: {
  text: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}): ModelProviderDriver {
  return {
    stream() {
      return resource(function* (provide) {
        const events: Array<
          | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
          | {
              type: "toolcall_end";
              contentIndex: number;
              toolCall: {
                type: "toolCall";
                id: string;
                name: string;
                arguments: Record<string, unknown>;
              };
              partial: AssistantMessage;
            }
        > = [];

        events.push({
          type: "text_delta",
          contentIndex: 0,
          delta: options.text,
          partial: {
            role: "assistant",
            content: [{ type: "text", text: options.text }],
          },
        });

        if (options.toolCall) {
          events.push({
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: {
              type: "toolCall",
              id: options.toolCall.id,
              name: options.toolCall.name,
              arguments: options.toolCall.arguments,
            },
            partial: {
              role: "assistant",
              content: [
                { type: "text", text: options.text },
                {
                  type: "toolCall",
                  id: options.toolCall.id,
                  name: options.toolCall.name,
                  arguments: options.toolCall.arguments,
                },
              ],
            },
          });
        }

        let index = 0;
        const finalMessage: AssistantMessage = {
          role: "assistant",
          content: [
            { type: "text", text: options.text },
            ...(options.toolCall
              ? [
                  {
                    type: "toolCall" as const,
                    id: options.toolCall.id,
                    name: options.toolCall.name,
                    arguments: options.toolCall.arguments,
                  },
                ]
              : []),
          ],
          stopReason: options.toolCall ? "toolUse" : "stop",
          usage: { input: 1, output: 1, total: 2 },
        };

        yield* provide({
          *next(): Operation<IteratorResult<unknown, AssistantMessage>> {
            if (index < events.length) {
              return { done: false, value: events[index++]! };
            }
            return { done: true, value: finalMessage };
          },
        } as Subscription<unknown, AssistantMessage>);
      });
    },
    *sample(request): Operation<AssistantMessage> {
      const subscription = yield* this.stream(request);
      while (true) {
        const next = yield* subscription.next();
        if (next.done) return next.value;
      }
    },
  };
}

function createLocalToolRuntime(
  tools: Array<{ name: string; parameters: unknown; description?: string }>,
): ToolRuntime {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return {
    id: "golden-path-local",
    *execute(request) {
      const tool = byName.get(request.call.function.name) as any;
      const ref = createToolExecutionRef({
        runtimeId: "golden-path-local",
        callId: request.call.id,
        toolName: request.call.function.name,
      });
      if (!tool) {
        return {
          kind: "failed",
          ref,
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Tool not found: ${request.call.function.name}`,
          },
        };
      }
      const params = validateToolParameters({
        schema: tool.parameters,
        params: request.call.function.arguments,
        toolName: tool.name,
        callId: request.call.id,
      });
      const toolCtx = {
        history: [],
        notify: function* () {},
        log: function* () {},
        elicit: function* (): Operation<never> {
          throw new Error("elicit not used in golden path");
        },
        sample: function* (): Operation<never> {
          throw new Error("sample not used in golden path");
        },
      };
      try {
        const invoke = yield* tool(toolCtx);
        const result = yield* invoke(params);
        return { kind: "completed", ref, result };
      } catch (error) {
        return {
          kind: "failed",
          ref,
          error: {
            code: "TOOL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    *resume(request) {
      return {
        kind: "failed",
        ref: request.ref,
        error: {
          code: "EXECUTION_NOT_FOUND",
          message: `Execution not found: ${request.ref.executionId}`,
        },
      };
    },
    *abort() {},
  };
}

function createEchoTool() {
  return createTool("echo")
    .description("Echoes the input string")
    .parameters(z.object({ input: z.string() }))
    .execute(function* (params) {
      return `echo:${params.input}`;
    });
}

describe("product facade golden path", () => {
  it("starts a chat app, defines a tool, sends a message, and completes a turn", async () => {
    const echo = createEchoTool();

    let providerCalls = 0;
    const provider: ModelProviderDriver = {
      stream(request) {
        const idx = providerCalls++;
        if (idx === 0) {
          return createScriptedModelProvider({
            text: "Calling echo",
            toolCall: {
              id: "call-echo-1",
              name: "echo",
              arguments: { input: "hello-facade" },
            },
          }).stream(request);
        }
        return createScriptedModelProvider({
          text: "Turn complete after echo",
        }).stream(request);
      },
      *sample(request): Operation<AssistantMessage> {
        const subscription = yield* this.stream(request);
        while (true) {
          const next = yield* subscription.next();
          if (next.done) return next.value;
        }
      },
    };

    const app = createChatApplication({
      setup: function* () {
        yield* setupInMemoryDurableStreams<string>();
        yield* ToolInventoryContext.set(
          createToolInventory([
            {
              definition: {
                name: echo.name,
                description: echo.description,
                parameters: z.toJSONSchema(echo.parameters),
              },
              implementation: echo,
              capabilities: { session: true },
            },
          ]),
        );
        yield* ToolRuntimeContext.set(createLocalToolRuntime([echo as any]));
      },
      handler: createChatHandler({
        setup: function* () {
          yield* ModelProviderContext.set(provider);
          yield* ModelProviderModelContext.set(mockModel());
        },
        maxToolIterations: 2,
      }),
    });

    try {
      const response = await app.handle(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ id: "user:1", role: "user", content: "Please echo hello-facade" }],
            enabledTools: true,
          }),
        }),
      );

      expect(response.status).toBe(200);
      const events = await readDurableEvents(response);

      const finished = eventsOfType(events, "RUN_FINISHED");
      expect(finished.length).toBeGreaterThanOrEqual(1);

      const toolResults = eventsOfType(events, "TOOL_CALL_RESULT");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(toolResults)).toContain("echo:hello-facade");

      const hasAssistantSignal =
        eventsOfType(events, "TEXT_MESSAGE_CONTENT").length > 0 ||
        toolResults.length > 0;
      expect(hasAssistantSignal).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("exposes required facade symbols from allowlisted paths", async () => {
    expect(typeof createChatApplication).toBe("function");
    expect(typeof createChatHandler).toBe("function");
    expect(typeof createTool).toBe("function");
    expect(typeof setupInMemoryDurableStreams).toBe("function");

    await call(function* () {
      yield* setupInMemoryDurableStreams<string>();
    });
  });
});
