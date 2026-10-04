// scenario-escape-hatch: provider wire conformance owns a standalone HTTP simulator;
// its request barrier is the simulator's causal nextRequest, not application choreography.
import { describe, expect, it } from "vitest";
import { run, type Operation } from "effection";
import {
  startModelSimulator,
  createSimulatorModel,
  type PendingModelRequest,
} from "@sweatpants/test-rig";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import type {
  ModelContext,
  ModelResponse,
  Model,
  ModelStreamEvent,
  StreamOptions,
} from "@sweatpants/model-provider";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";

type ModelRun = {
  events: ModelStreamEvent[];
  message: ModelResponse;
};

const toolSchema = {
  type: "object",
  properties: {
    origin: { type: "string" },
    destination: { type: "string" },
  },
  required: ["origin", "destination"],
};

function startProvider(
  model: Model,
  context: { messages: ChatMessage[]; tools?: ChatToolDefinition[] },
  options?: StreamOptions,
): Promise<ModelRun> {
  const canonicalContext: ModelContext = { messages: context.messages, tools: context.tools ?? [] };
  return run(function* (): Operation<ModelRun> {
    const subscription = yield* createPiAiModelProvider().runtime.stream(model, canonicalContext, {
      apiKey: "sk-sweatpants-test-only",
      ...options,
    });
    const events: ModelStreamEvent[] = [];
    let next = yield* subscription.next();
    while (!next.done) {
      events.push(next.value);
      next = yield* subscription.next();
    }
    return { events, message: next.value };
  });
}

async function setupProvider(): Promise<{
  simulator: Awaited<ReturnType<typeof startModelSimulator>>;
  model: Model;
}> {
  const simulator = await startModelSimulator(undefined, { unmatchedRequests: "buffer" });
  return {
    simulator,
    model: createSimulatorModel("sim-model", simulator.baseUrl),
  };
}

async function answerText(request: PendingModelRequest, text = "done"): Promise<void> {
  await request.respond.text(text);
}

describe("pi-ai provider over the simulated Responses wire", () => {
  it("transports the authored tool projection without re-deriving it", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(
        model,
        {
          messages: [{ role: "user", content: "Book a flight from NYC to LA" }],
          tools: [{ name: "book_flight", description: "Book a flight", parameters: toolSchema }],
        },
        { apiKey: "sk-sweatpants-test-only" },
      );
      const request = await simulator.model.nextRequest();

      expect(request.body.tools).toEqual([
        {
          type: "function",
          name: "book_flight",
          description: "Book a flight",
          parameters: toolSchema,
        },
      ]);
      expect(request.body.tools).not.toMatchObject([{ strict: expect.anything() }]);
      expect(() => structuredClone(request.body)).not.toThrow();
      await answerText(request);
      await stream;
    } finally {
      await simulator.close();
    }
  });

  it("transports structured response projection and unwraps the schema tool", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(
        model,
        { messages: [{ role: "user", content: "Pick a cell" }] },
        {
          apiKey: "sk-sweatpants-test-only",
          responseFormat: {
            type: "json_schema",
            name: "move",
            schema: { type: "object", properties: { cell: { type: "number" } } },
          },
        },
      );
      const request = await simulator.model.nextRequest();

      expect(request.body.tools).toMatchObject([
        {
          type: "function",
          name: "__schema__",
          description: "Respond with structured data matching this schema.",
        },
      ]);
      expect(request.body).toMatchObject({ tool_choice: "required" });
      await request.respond.toolCalls([
        { id: "schema-call", name: "__schema__", arguments: { cell: 4 } },
      ]);

      const result = await stream;
      expect(result.message).toMatchObject({
        message: { content: [{ type: "text", text: '{"cell":4}' }] },
        stopReason: "stop",
      });
    } finally {
      await simulator.close();
    }
  });

  it("preserves completed causal tool history in wire order", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(model, {
        messages: [
          { role: "user", content: "Book an outbound flight" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCall: {
                  id: "call-complete",
                  name: "book_flight",
                  input: {},
                  thoughtSignature: null,
                },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call-complete",
            name: "book_flight",
            content: [{ type: "text", text: '{"success":true}' }],
            isError: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Outbound confirmed." }],
          },
          { role: "user", content: "Now book the return flight" },
        ],
      });
      const request = await simulator.model.nextRequest();
      const input = JSON.stringify(request.body.input);

      expect(input).toContain("call-complete");
      expect(input).toContain("Outbound confirmed.");
      expect(input).not.toContain("call-abandoned");
      await answerText(request);
      await stream;
    } finally {
      await simulator.close();
    }
  });

  it("rejects an unsettled historical tool call instead of silently dropping it", async () => {
    const { simulator, model } = await setupProvider();
    try {
      await expect(
        startProvider(model, {
          messages: [
            { role: "user", content: "Book it" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCall: {
                    id: "call-abandoned",
                    name: "book",
                    input: {},
                    thoughtSignature: null,
                  },
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "unsupported-model-capability",
        modality: "unsettled-tool-call",
      });
      expect(simulator.model.requests()).toHaveLength(0);
    } finally {
      await simulator.close();
    }
  });

  it("keeps completed tool/result messages in wire order", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(model, {
        messages: [
          { role: "user", content: "Book it" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCall: {
                  id: "call-1",
                  name: "book",
                  input: {},
                  thoughtSignature: null,
                },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            name: "book",
            content: [{ type: "text", text: "confirmed" }],
            isError: false,
          },
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
          { role: "user", content: "Thanks" },
        ],
      });
      const request = await simulator.model.nextRequest();
      const input = JSON.stringify(request.body.input);
      expect(input.indexOf("call-1")).toBeGreaterThanOrEqual(0);
      expect(input.indexOf("confirmed")).toBeGreaterThan(input.indexOf("call-1"));
      expect(input.indexOf("Done.")).toBeGreaterThan(input.indexOf("confirmed"));
      await answerText(request);
      await stream;
    } finally {
      await simulator.close();
    }
  });

  it("maps thinking settings onto the real provider request", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(
        model,
        { messages: [{ role: "user", content: "Think hard" }] },
        { thinking: "high", thinkingBudgets: { high: 1234 } },
      );
      const request = await simulator.model.nextRequest();
      expect(request.body).toMatchObject({ reasoning: { effort: "high" } });
      await answerText(request);
      await stream;
    } finally {
      await simulator.close();
    }
  });

  it("streams chunked tool calls through the real client without aborting", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(model, { messages: [{ role: "user", content: "Book it" }] });
      const request = await simulator.model.nextRequest();
      await request.respond.toolCalls(
        [{ id: "call-1", name: "book_flight", arguments: { origin: "NYC", destination: "LA" } }],
        { argumentChunkSize: 1 },
      );

      const result = await stream;
      expect(result.events.some((event) => event.type === "tool-call-delta")).toBe(true);
      expect(result.message.source).toEqual({
        api: "openai-responses",
        provider: "openai",
        model: "sim-model",
        responseModel: null,
      });
      expect(result.message.message.content).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          toolCall: expect.objectContaining({
            id: expect.stringContaining("call-1"),
            name: "book_flight",
            input: { origin: "NYC", destination: "LA" },
            thoughtSignature: null,
          }),
        }),
      );
    } finally {
      await simulator.close();
    }
  });

  it("characterizes the vendor client's malformed-argument normalization", async () => {
    for (const [emitted, expected] of [
      ['{"origin":"NYC"', { origin: "NYC" }],
      ["this is not json at all", {}],
    ] as const) {
      const { simulator, model } = await setupProvider();
      try {
        const stream = startProvider(model, { messages: [{ role: "user", content: "Book it" }] });
        const request = await simulator.model.nextRequest();
        await request.respond.malformedToolCall({
          id: "call-1",
          name: "book_flight",
          arguments: emitted,
        });

        const result = await stream;
        expect(result.message.message.content).toContainEqual(
          expect.objectContaining({
            type: "tool-call",
            toolCall: expect.objectContaining({ input: expected }),
          }),
        );
      } finally {
        await simulator.close();
      }
    }
  });

  it("rejects reserved response tools before making a provider request", async () => {
    const { simulator, model } = await setupProvider();
    try {
      await expect(
        startProvider(
          model,
          {
            messages: [{ role: "user", content: "Pick a cell" }],
            tools: [{ name: "__schema__", description: "collision", parameters: toolSchema }],
          },
          {
            responseFormat: { type: "json_schema", schema: { type: "object" } },
          },
        ),
      ).rejects.toThrow("reserved for structured response output");
      expect(simulator.model.requests()).toHaveLength(0);
    } finally {
      await simulator.close();
    }
  });

  it("rejects response tools combined with application tools before the wire", async () => {
    const { simulator, model } = await setupProvider();
    try {
      await expect(
        startProvider(
          model,
          {
            messages: [{ role: "user", content: "Pick a cell" }],
            tools: [{ name: "echo", description: "echo", parameters: toolSchema }],
          },
          { responseFormat: { type: "json_schema", schema: { type: "object" } } },
        ),
      ).rejects.toThrow("responseFormat cannot be combined with application tools");
      expect(simulator.model.requests()).toHaveLength(0);
    } finally {
      await simulator.close();
    }
  });

  it("passes provider failures through the real stream contract", async () => {
    const { simulator, model } = await setupProvider();
    try {
      const stream = startProvider(model, { messages: [{ role: "user", content: "fail" }] });
      const request = await simulator.model.nextRequest();
      await request.respond.error({ code: "upstream_failure", message: "provider unavailable" });

      const result = await stream;
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "error",
          reason: "error",
          error: expect.objectContaining({ role: "assistant", content: [] }),
        }),
      );
    } finally {
      await simulator.close();
    }
  });
});
