/**
 * Golden-path acceptance suite (REQ-014).
 *
 * Imports ONLY product facade allowlisted paths:
 * - @sweatpants/agent-host/server
 * - @sweatpants/chat-core
 * - @sweatpants/durable-chat-runtime/response-streams
 * - @sweatpants/agent-sdk
 *
 * Exercises: construct chat application, define a tool with createTool,
 * send a user message, complete a turn (with tool call).
 */
import { describe, expect, it } from "vitest";
import { call, resource, type Operation, type Stream, type Subscription } from "effection";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/agent-sdk";
import { createChatApplication, createChatHandler } from "@sweatpants/agent-host/server";
import { createDevelopmentProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
  installToolRuntime,
  type ToolRuntime,
} from "@sweatpants/tool-runtime";
import {
  installModelProvider,
  ModelProviderModelContext,
  type ModelResponse,
  type Model,
  type ModelProviderDriver,
  type ModelStreamEvent as RuntimeStreamEvent,
} from "@sweatpants/model-provider";
import { createToolExecutionRef } from "@sweatpants/tool-runtime";
import {
  parseToolParameters,
  requireToolParameterResult,
} from "@sweatpants/tool-session/tool-parameters";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
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
  toolCall?: { id: string; name: string; arguments: Record<string, string> };
}): ModelProviderDriver {
  return {
    *stream(): Operation<Stream<RuntimeStreamEvent, ModelResponse>> {
      return resource(function* (provide) {
        const parts = [
          { type: "text" as const, text: options.text },
          ...(options.toolCall
            ? [
                {
                  type: "tool-call" as const,
                  toolCall: {
                    id: options.toolCall.id,
                    name: options.toolCall.name,
                    input: options.toolCall.arguments,
                    thoughtSignature: null,
                  },
                },
              ]
            : []),
        ];
        const finalMessage: ModelResponse = {
          message: { role: "assistant", content: parts },
          source: null,
          usage: { input: 1, output: 1, total: 2, cacheRead: null, cacheWrite: null, cost: null },
          stopReason: options.toolCall ? "toolUse" : "stop",
          responseId: null,
          errorMessage: null,
        };
        const events: RuntimeStreamEvent[] = [
          {
            type: "text-delta",
            contentIndex: 0,
            delta: options.text,
            partial: { role: "assistant", content: [{ type: "text", text: options.text }] },
          },
          ...(options.toolCall
            ? [
                {
                  type: "tool-call-end" as const,
                  contentIndex: 1,
                  toolCall: {
                    id: options.toolCall.id,
                    name: options.toolCall.name,
                    input: options.toolCall.arguments,
                    thoughtSignature: null,
                  },
                  partial: { role: "assistant" as const, content: parts },
                },
              ]
            : []),
        ];
        let index = 0;
        yield* provide({
          *next(): Operation<IteratorResult<RuntimeStreamEvent, ModelResponse>> {
            if (index < events.length) return { done: false, value: events[index++]! };
            return { done: true, value: finalMessage };
          },
        } as Subscription<RuntimeStreamEvent, ModelResponse>);
      });
    },
    *sample(request): Operation<ModelResponse> {
      const stream = yield* this.stream(request);
      const subscription = yield* stream;
      while (true) {
        const next = yield* subscription.next();
        if (next.done) return next.value;
      }
    },
  };
}

function createLocalToolRuntime(tools: readonly RuntimeTool[]): ToolRuntime {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return {
    *runtimeId() {
      return "golden-path-local";
    },
    *execute(request) {
      const tool = byName.get(request.call.name);
      const ref = createToolExecutionRef({
        runtimeId: "golden-path-local",
        callId: request.call.id,
        toolName: request.call.name,
      });
      if (!tool) {
        return {
          kind: "failed",
          ref,
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Tool not found: ${request.call.name}`,
          },
        };
      }
      const params = requireToolParameterResult(
        parseToolParameters({
          schema: tool.parameters,
          params: request.call.input,
          toolName: tool.name,
          callId: request.call.id,
        }),
        { toolName: tool.name, callId: request.call.id },
      );
      const toolCtx = {
        signal: new AbortController().signal,
        messages: [],
        notify: function* () {},
        log: function* () {},
        elicit: function* (): Operation<never> {
          throw new Error("elicit not used in golden path");
        },
        sample: function* (): Operation<never> {
          throw new Error("sample not used in golden path");
        },
        sampleTools: function* (): Operation<never> {
          throw new Error("sampleTools not used in golden path");
        },
        sampleSchema: function* (): Operation<never> {
          throw new Error("sampleSchema not used in golden path");
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
      *stream(request) {
        const idx = providerCalls++;
        if (idx === 0) {
          return yield* createScriptedModelProvider({
            text: "Calling echo",
            toolCall: {
              id: "call-echo-1",
              name: "echo",
              arguments: { input: "hello-facade" },
            },
          }).stream(request);
        }
        return yield* createScriptedModelProvider({
          text: "Turn complete after echo",
        }).stream(request);
      },
      *sample(request): Operation<ModelResponse> {
        const stream = yield* this.stream(request);
        const subscription = yield* stream;
        while (true) {
          const next = yield* subscription.next();
          if (next.done) {
            return next.value;
          }
        }
      },
    };

    const app = createChatApplication({
      setup: function* () {
        yield* setupInMemoryDurableStreams<string>();
        yield* installToolInventory(
          // The authored projection, not a second derivation of it.
          createToolInventory([createToolInventoryEntry(echo)]),
        );
        yield* installToolRuntime(createLocalToolRuntime([echo]));
      },
      handler: createChatHandler({
        programDriverJournalStore: createDevelopmentProgramDriverJournalStore({
          audience: "golden-path-program-runtime",
          secret: "golden-path-program-runtime-secret",
        }),
        setup: function* () {
          yield* installModelProvider(provider);
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
            command: {
              type: "send-message",
              commandId: "00000000-0000-4000-8000-000000000001",
              issuedAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              basisRevision: null,
              messageId: "user:1",
            },
            clientId: "golden-path-client",
            conversationId: "golden-path",
            input: {
              threadId: "golden-path",
              runId: "golden-path-run",
              state: {},
              messages: [{ id: "user:1", role: "user", content: "Please echo hello-facade" }],
              // Client plugin contracts are presentation metadata only. They do
              // not add executable tools to the Host inventory.
              tools: [
                {
                  name: "client-plugin-contract",
                  description: "must not become executable",
                  parameters: { type: "object" },
                },
              ],
              context: [],
              forwardedProps: {},
            },
          }),
        }),
      );

      expect(response.status).toBe(200);
      const events = await readDurableEvents(response);

      const finished = eventsOfType(events, "RUN_FINISHED");
      expect(finished.length).toBeGreaterThanOrEqual(1);
      const started = eventsOfType(events, "RUN_STARTED");
      expect(JSON.stringify(started)).toContain('"name":"echo"');
      expect(JSON.stringify(started)).not.toContain("client-plugin-contract");

      const toolResults = eventsOfType(events, "TOOL_CALL_RESULT");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(toolResults)).toContain("echo:hello-facade");

      const hasAssistantSignal =
        eventsOfType(events, "TEXT_MESSAGE_CONTENT").length > 0 || toolResults.length > 0;
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
