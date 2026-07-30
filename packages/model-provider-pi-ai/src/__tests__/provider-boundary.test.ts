import { run, type Operation } from "effection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiRuntime } from "../runtime/pi-ai.ts";
import type { AssistantMessage, Context, Model } from "../runtime/types.ts";

const piAiMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  generateImages: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: piAiMocks.streamSimple,
  generateImages: piAiMocks.generateImages,
}));

const testModel: Model = {
  id: "zai.glm-5",
  name: "GLM 5",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const finalPiMessage = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "done" }],
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  model: "zai.glm-5",
  stopReason: "stop" as const,
  timestamp: 1,
};

function assistantMessageWith(content: unknown[]): unknown {
  return { ...finalPiMessage, content };
}

function mockPiStream(events: unknown[], finalMessage: unknown = finalPiMessage): void {
  piAiMocks.streamSimple.mockReturnValue({
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (index < events.length) {
            return { done: false, value: events[index++] };
          }
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<unknown>> {
          return { done: true, value: undefined };
        },
      };
    },
    result: vi.fn(async () => finalMessage),
  });
}

beforeEach(() => {
  piAiMocks.streamSimple.mockReset();
  piAiMocks.generateImages.mockReset();
  mockPiStream([]);
});

describe("pi-ai provider boundary normalization", () => {
  it("transports the authored tool projection without re-deriving it", async () => {
    const runtime = createPiAiRuntime();
    // Callers hand the provider the projection authored upstream. The provider
    // owns transport, not schema derivation.
    const context: Context = {
      messages: [{ role: "user", content: "Book a flight from NYC to LA" }],
      tools: [
        {
          name: "book_flight",
          description: "Book a flight",
          parameters: {
            type: "object",
            properties: { origin: { type: "string" }, destination: { type: "string" } },
            required: ["origin", "destination"],
          },
        },
      ],
    };

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, context);
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    expect(piAiMocks.streamSimple).toHaveBeenCalledTimes(1);
    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    const toolSchema = piContext.tools[0].parameters;

    expect(toolSchema).toMatchObject({
      type: "object",
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
      },
      required: ["origin", "destination"],
    });
    expect((toolSchema as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(() => structuredClone({ tools: piContext.tools })).not.toThrow();
  });

  it("transports the authored response projection as the __schema__ tool", async () => {
    const runtime = createPiAiRuntime();

    await run(function* () {
      const subscription = yield* runtime.stream(
        testModel,
        {
          messages: [{ role: "user", content: "Book a flight from NYC to LA" }],
        },
        {
          responseFormat: {
            type: "json_schema",
            name: "booking_result",
            schema: {
              type: "object",
              properties: { confirmation: { type: "string" } },
              required: ["confirmation"],
            },
          },
        },
      );
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    expect(piAiMocks.streamSimple).toHaveBeenCalledTimes(1);
    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    const responseSchema = piContext.tools[0].parameters;

    expect(responseSchema).toMatchObject({
      type: "object",
      properties: { confirmation: { type: "string" } },
      required: ["confirmation"],
    });
    expect((responseSchema as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(piContext.tools[0]).toMatchObject({
      name: "__schema__",
      description: "Respond with structured data matching this schema.",
    });
    expect(() => structuredClone({ tools: piContext.tools })).not.toThrow();
  });

  it("drops empty assistant and pending tool-result replay messages before calling pi-ai", async () => {
    const runtime = createPiAiRuntime();

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: "user", content: "Book a flight" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "book_flight",
                arguments: { from: "LAX", destination: "NYC" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "book_flight",
            content: [{ type: "text", text: "" }],
            isError: false,
          },
          { role: "assistant", content: [] },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "book_flight",
            content: [{ type: "text", text: '{"success":true,"ticketNumber":"TKT-123"}' }],
            isError: false,
          },
        ],
      });
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    expect(piContext.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(piContext.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: '{"success":true,"ticketNumber":"TKT-123"}' }],
    });
  });

  it("preserves historical completed tool protocol in causal order (REQ-038)", async () => {
    const runtime = createPiAiRuntime();

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: "user", content: "Book an outbound flight" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "book_flight",
                arguments: { from: "LAX", destination: "NYC" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "book_flight",
            content: [{ type: "text", text: '{"success":true,"ticketNumber":"TKT-123"}' }],
            isError: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Your outbound flight is confirmed. Ticket TKT-123." }],
          },
          { role: "user", content: "Now book the return flight" },
        ],
      });
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    // Completed call/result pairs are semantic causal history: a follow-up
    // turn must see the outer call, its result, and the terminal summary
    // exactly once and in order. Compaction is client/application policy,
    // never a silent provider-boundary behavior.
    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    expect(piContext.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect(piContext.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "book_flight" }],
    });
    expect(piContext.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
  });

  it("drops hanging tool calls that never received a result before calling pi-ai", async () => {
    const runtime = createPiAiRuntime();

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: "user", content: "Book an outbound flight" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-abandoned",
                name: "book_flight",
                arguments: { from: "LAX", destination: "NYC" },
              },
            ],
          },
          { role: "user", content: "Never mind, just tell me the weather" },
        ],
      });
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    // A function_call without a function_call_output is wire-invalid for the
    // Responses API. The boundary drops only the unresolvable call; upstream
    // projection (cancel-on-send) is responsible for recording cancellations.
    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    expect(piContext.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "user",
    ]);
    expect(JSON.stringify(piContext.messages)).not.toContain("call-abandoned");
  });

  it("omits orphan historical tool results before calling pi-ai", async () => {
    const runtime = createPiAiRuntime();

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [
          { role: "user", content: "Book an outbound flight" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Your outbound flight is confirmed. Ticket TKT-123." }],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "book_flight",
            content: [{ type: "text", text: '{"success":true,"ticketNumber":"TKT-123"}' }],
            isError: false,
          },
          { role: "user", content: "Now book the return flight" },
        ],
      });
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    const [, piContext] = piAiMocks.streamSimple.mock.calls[0]!;
    expect(piContext.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(piContext.messages)).not.toContain("toolResult");
  });

  it("normalizes provider tool-call arguments that arrive as JSON strings", async () => {
    const runtime = createPiAiRuntime();
    const partial = {
      ...finalPiMessage,
      content: [
        {
          type: "toolCall" as const,
          id: "call-1",
          name: "book_flight",
          arguments: '{"origin":"NYC","destination":"LAX"}',
        },
      ],
    };
    mockPiStream([
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          id: "call-1",
          name: "book_flight",
          arguments: '{"origin":"NYC","destination":"LAX"}',
        },
        partial,
      },
    ]);

    let assistant: AssistantMessage | undefined;
    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [{ role: "user", content: "Book a flight" }],
      });
      const next = yield* subscription.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        expect(next.value).toMatchObject({
          type: "toolcall_end",
          toolCall: {
            id: "call-1",
            name: "book_flight",
            arguments: { origin: "NYC", destination: "LAX" },
          },
          partial: {
            content: [
              {
                type: "toolCall",
                arguments: { origin: "NYC", destination: "LAX" },
              },
            ],
          },
        });
      }
      const done = yield* subscription.next();
      expect(done.done).toBe(true);
      if (done.done) {
        assistant = done.value;
      }
    });

    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });

  it("passes every non-off thinking level as pi-ai simple reasoning without provider-specific reasoning effort", async () => {
    const runtime = createPiAiRuntime();
    const levels = ["minimal", "low", "medium", "high", "xhigh"] as const;

    for (const level of levels) {
      piAiMocks.streamSimple.mockClear();
      mockPiStream([]);
      await run(function* () {
        const subscription = yield* runtime.stream(
          testModel,
          {
            messages: [{ role: "user", content: "Think hard" }],
          },
          {
            thinking: level,
            ...(level === "high" ? { thinkingBudgets: { high: 1234 } } : {}),
          },
        );
        const next = yield* subscription.next();
        expect(next.done).toBe(true);
      });

      const [, , piOptions] = piAiMocks.streamSimple.mock.calls[0]!;
      expect(piOptions).toMatchObject({ reasoning: level });
      if (level === "high") {
        expect(piOptions).toMatchObject({ thinkingBudgets: { high: 1234 } });
      }
      expect(piOptions).not.toHaveProperty("reasoningEffort");
      expect(piOptions).not.toHaveProperty("thinkingEnabled");
      expect(piOptions).not.toHaveProperty("thinkingBudgetTokens");
    }
  });

  it("normalizes default and explicit off thinking settings", async () => {
    const runtime = createPiAiRuntime();

    await run(function* () {
      const subscription = yield* runtime.stream(testModel, {
        messages: [{ role: "user", content: "Default" }],
      });
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });
    expect(piAiMocks.streamSimple.mock.calls[0]![2]).not.toHaveProperty("reasoning");

    piAiMocks.streamSimple.mockClear();
    mockPiStream([]);
    await run(function* () {
      const subscription = yield* runtime.stream(
        testModel,
        {
          messages: [{ role: "user", content: "No thinking" }],
        },
        { thinking: "off" },
      );
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });
    expect(piAiMocks.streamSimple.mock.calls[0]![2]).not.toHaveProperty("reasoning");
    expect(piAiMocks.streamSimple.mock.calls[0]![2]).not.toHaveProperty("reasoningEffort");
  });

  it("preserves thinkingLevelMap when converting Sweatpants models to pi-ai models", async () => {
    const runtime = createPiAiRuntime();
    const model: Model = {
      ...testModel,
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        high: "high",
        xhigh: null,
      },
    };

    await run(function* () {
      const subscription = yield* runtime.stream(
        model,
        {
          messages: [{ role: "user", content: "Use model map" }],
        },
        { thinking: "high" },
      );
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
    });

    const [piModel] = piAiMocks.streamSimple.mock.calls[0]!;
    expect(piModel.thinkingLevelMap).toEqual(model.thinkingLevelMap);
  });

  it("unwraps responseFormat __schema__ tool calls into JSON text", async () => {
    const runtime = createPiAiRuntime();
    const finalMessage = {
      ...finalPiMessage,
      stopReason: "toolUse" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "call-schema",
          name: "__schema__",
          arguments: { cell: 4 },
        },
      ],
    };
    mockPiStream(
      [
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            id: "call-schema",
            name: "__schema__",
            arguments: { cell: 4 },
          },
          partial: finalMessage,
        },
      ],
      finalMessage,
    );

    let assistant: AssistantMessage | undefined;
    await run(function* () {
      const subscription = yield* runtime.stream(
        testModel,
        {
          messages: [{ role: "user", content: "Pick a cell" }],
        },
        {
          responseFormat: {
            type: "json_schema",
            name: "move",
            schema: {
              type: "object",
              properties: { cell: { type: "number" } },
              required: ["cell"],
            },
          },
        },
      );
      const next = yield* subscription.next();
      expect(next.done).toBe(true);
      if (next.done) {
        assistant = next.value;
      }
    });

    const [, piContext, piOptions] = piAiMocks.streamSimple.mock.calls[0]!;
    expect(piContext.tools[0]).toMatchObject({ name: "__schema__" });
    expect(piOptions).toMatchObject({ toolChoice: "required" });
    expect(piOptions).not.toHaveProperty("responseFormat");
    expect(assistant).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: '{"cell":4}' }],
    });
  });

  it("rejects responseFormat requests that collide with the reserved __schema__ tool name without leaking secrets", async () => {
    const runtime = createPiAiRuntime();

    let error: unknown;
    try {
      await run(function* () {
        const subscription = yield* runtime.stream(
          testModel,
          {
            messages: [{ role: "user", content: "Pick a cell" }],
            tools: [
              { name: "__schema__", description: "user tool", parameters: { type: "object" } },
            ],
          },
          {
            responseFormat: {
              type: "json_schema",
              schema: { type: "object" },
            },
            apiKey: "sk-secret-test-value",
            providerOptions: { Authorization: "Bearer very-secret-token" },
          },
        );
        yield* subscription.next();
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("reserved for structured response output");
    expect(message).not.toContain("sk-secret-test-value");
    expect(message).not.toContain("very-secret-token");
    expect(piAiMocks.streamSimple).not.toHaveBeenCalled();
  });

  it("rejects responseFormat requests with application tools to keep schema output deterministic", async () => {
    const runtime = createPiAiRuntime();

    await expect(
      run(function* () {
        const subscription = yield* runtime.stream(
          testModel,
          {
            messages: [{ role: "user", content: "Pick a cell" }],
            tools: [{ name: "echo", description: "echo", parameters: { type: "object" } }],
          },
          {
            responseFormat: {
              type: "json_schema",
              schema: { type: "object" },
            },
          },
        );
        yield* subscription.next();
      }),
    ).rejects.toThrow("responseFormat cannot be combined with application tools");

    expect(piAiMocks.streamSimple).not.toHaveBeenCalled();
  });
  it("carries model arguments through untouched, including text it failed to encode", async () => {
    const runtime = createPiAiRuntime();
    const message = assistantMessageWith([
      { type: "text", text: "calling" },
      {
        type: "toolCall",
        id: "call_1",
        name: "book_flight",
        arguments: '{"origin":"NYC"',
      },
    ]);
    mockPiStream([], message);

    const result = await run(function* (): Operation<AssistantMessage> {
      const subscription = yield* runtime.stream(testModel, {
        messages: [{ role: "user", content: "book it" }],
      });
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return next.value;
    });

    const call = result.content.find((block) => block.type === "toolCall");
    // Not `{}`: the model's real output survives so the authored parameter
    // schema can report the actual cause instead of "missing required field".
    expect(call).toMatchObject({ arguments: '{"origin":"NYC"' });
  });

  it("decodes provider JSON-string arguments exactly once", async () => {
    const runtime = createPiAiRuntime();
    mockPiStream(
      [],
      assistantMessageWith([
        {
          type: "toolCall",
          id: "call_2",
          name: "book_flight",
          arguments: '{"origin":"NYC","destination":"LA"}',
        },
      ]),
    );

    const result = await run(function* (): Operation<AssistantMessage> {
      const subscription = yield* runtime.stream(testModel, {
        messages: [{ role: "user", content: "book it" }],
      });
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return next.value;
    });

    expect(result.content.find((block) => block.type === "toolCall")).toMatchObject({
      arguments: { origin: "NYC", destination: "LA" },
    });
  });

  it("keeps streaming while a tool call is still accumulating", async () => {
    const runtime = createPiAiRuntime();
    // Providers stream tool calls incrementally: the partial snapshot carries an
    // id and name that have not arrived yet. That is mid-flight, not a
    // violation, so it must not abort the stream.
    mockPiStream(
      [
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"origin"',
          partial: assistantMessageWith([
            { type: "toolCall", id: "call_1", name: "", arguments: "" },
          ]),
        },
      ],
      assistantMessageWith([
        { type: "toolCall", id: "call_1", name: "book_flight", arguments: { origin: "NYC" } },
      ]),
    );

    const types = await run(function* (): Operation<string[]> {
      const subscription = yield* runtime.stream(testModel, {
        messages: [{ role: "user", content: "book it" }],
      });
      const seen: string[] = [];
      let next = yield* subscription.next();
      while (!next.done) {
        seen.push((next.value as { type: string }).type);
        next = yield* subscription.next();
      }
      return seen;
    });

    expect(types).toContain("toolcall_delta");
  });

  it("refuses to invent identity for a tool call the provider left unidentified", async () => {
    const runtime = createPiAiRuntime();
    mockPiStream(
      [],
      assistantMessageWith([{ type: "toolCall", name: "book_flight", arguments: {} }]),
    );

    await expect(
      run(function* () {
        const subscription = yield* runtime.stream(testModel, {
          messages: [{ role: "user", content: "book it" }],
        });
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
        return next.value;
      }),
    ).rejects.toThrow("without an id");
  });
});
