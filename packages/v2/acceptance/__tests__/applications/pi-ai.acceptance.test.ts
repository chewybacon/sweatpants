import { expect, it, onTestFinished } from "vitest";
import { createPiAiProvider, type PiAiProviderOptions } from "@sweatpan.ts/providers-pi-ai";
import type { ModelRequest, ModelStreamEvent } from "@sweatpan.ts/providers";
import { createPiAiStreamRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const model: PiAiProviderOptions["model"] = {
  id: "fixture",
  name: "Fixture",
  api: "test-api",
  provider: "test",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 10,
  output: 4,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 16,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};
const text = {
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  responseId: "response-1",
  usage,
  stopReason: "stop",
  timestamp: 0,
};
const terminal = {
  ...text,
  content: [
    ...text.content,
    { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
    {
      type: "toolCall",
      id: "call-1",
      name: "confirm",
      arguments: { question: "Proceed?" },
      thoughtSignature: "signature",
    },
  ],
  stopReason: "toolUse",
};
const request: ModelRequest = {
  context: {
    messages: [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Hello" },
    ],
    tools: [{ name: "confirm", description: null, parameters: { type: "object" } }],
  },
  options: { temperature: 0, maxTokens: 128, thinking: "low" },
};

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: pi-ai translates text, reasoning and tool results with scoped resource ownership`, async () => {
    const peer = createPiAiStreamRig({
      events: [
        { type: "start", partial: text },
        { type: "text_delta", contentIndex: 0, delta: "Hello", partial: text },
        { type: "thinking_end", contentIndex: 1, content: "", partial: terminal },
        { type: "toolcall_end", contentIndex: 2, toolCall: terminal.content[2], partial: terminal },
        { type: "done", reason: "toolUse", message: terminal },
      ],
      result: terminal,
    });
    const provider = createPiAiProvider(runtime, { model, stream: peer.stream });
    const task = runtime.start(function* () {
      const reader = yield* provider.stream(request);
      const events: ModelStreamEvent[] = [];
      while (true) {
        const next = yield* reader.next();
        if (next.done) {
          expect(yield* reader.next()).toEqual(next);
          return { events, response: next.value, reader };
        }
        events.push(next.value);
      }
    });
    onTestFinished(() => task.cancel());
    const result = await task.result;
    expect(result.events.map((event) => event.type)).toEqual([
      "start",
      "text-delta",
      "reasoning-end",
      "tool-call-end",
      "done",
    ]);
    expect(result.response).toMatchObject({
      source: { provider: "test", model: "fixture" },
      responseId: "response-1",
      usage: { total: 16, cost: { total: 3 } },
      stopReason: "toolUse",
    });
    expect(result.response.message.content[1]).toEqual({
      type: "reasoning",
      text: "",
      format: null,
      signature: "opaque",
      redacted: true,
    });
    expect(peer.requests[0]?.context).toMatchObject({
      messages: [
        {
          role: "system",
          content: "Be concise",
          toolsAdded: [{ name: "confirm", parameters: { type: "object" } }],
        },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    });
    expect(peer.released).toBe(1);
    expect(peer.signals[0]?.aborted).toBe(true);
    const escaped = runtime.start(() => result.reader.next());
    onTestFinished(() => escaped.cancel());
    await expect(escaped.result).rejects.toThrow("scope exited");
    const continuation = runtime.start(function* () {
      const reader = yield* provider.stream({
        context: {
          tools: [],
          messages: [
            ...request.context.messages,
            result.response.message,
            {
              role: "tool",
              name: "confirm",
              toolCallId: "call-1",
              content: "approved",
              isError: false,
            },
          ],
        },
      });
      return yield* reader.next();
    });
    onTestFinished(() => continuation.cancel());
    await continuation.result;
    expect(peer.requests[1]?.context).toMatchObject({
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "thinking", thinkingSignature: "opaque" },
            { type: "toolCall", id: "call-1", thoughtSignature: "signature" },
          ],
        },
        { role: "toolResult", toolCallId: "call-1", isError: false },
      ],
    });
  });

  for (const fault of ["cancel", "malformed-event", "error-event", "malformed-result"] as const) {
    it(`${runtime.name}: pi-ai ${fault} aborts and joins the SDK iterator`, async () => {
      const first = { type: "text_delta", contentIndex: 0, delta: "Hello", partial: text };
      const bad =
        fault === "error-event"
          ? { type: "error", reason: "error", error: { ...text, stopReason: "error" } }
          : { ...first, delta: 123 };
      const peer = createPiAiStreamRig({
        events: fault === "cancel" || fault === "malformed-result" ? [first] : [first, bad],
        result: { ...text, usage: { ...usage, input: "invalid" } },
        pauseAfter: fault === "cancel" ? 1 : undefined,
      });
      const provider = createPiAiProvider(runtime, { model, stream: peer.stream });
      const seen: ModelStreamEvent[] = [];
      const task = runtime.start(function* () {
        const reader = yield* provider.stream(request);
        while (true) {
          const next = yield* reader.next();
          if (next.done) {
            throw new Error("Unexpected successful response");
          }
          seen.push(next.value);
        }
      });
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      if (fault === "cancel") {
        await Promise.race([peer.peer.waitForRequests(1), task.result]);
        await task.cancel();
        expect(peer.peer.aborted).toEqual(["sdk"]);
      } else {
        await expect(task.result).rejects.toThrow(
          fault === "error-event" ? "Pi-ai provider failed" : "Invalid pi-ai response data",
        );
      }
      expect(seen).toHaveLength(1);
      expect(peer.signals[0]?.aborted).toBe(true);
      expect(peer.released).toBe(1);
    });
  }

  it(`${runtime.name}: pi-ai rejects unsupported requests before dispatch`, async () => {
    const peer = createPiAiStreamRig({ events: [], result: text });
    const provider = createPiAiProvider(runtime, { model, stream: peer.stream });
    const invalid: ModelRequest[] = [
      {
        context: {
          tools: [],
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  text: "opaque",
                  format: "custom",
                  signature: null,
                  redacted: false,
                },
              ],
            },
          ],
        },
      },
      { ...request, options: { responseFormat: { type: "json_schema", schema: {} } } },
      { ...request, options: { toolChoice: "required" } },
      {
        context: {
          tools: [],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "url", value: "https://invalid.example/image" },
                  metadata: null,
                },
              ],
            },
          ],
        },
      },
      {
        context: {
          tools: [],
          messages: [
            {
              role: "tool",
              toolCallId: "missing",
              name: "confirm",
              content: "yes",
              isError: false,
            },
          ],
        },
      },
    ];
    for (const input of invalid) {
      const task = runtime.start(() => provider.stream(input));
      onTestFinished(() => task.cancel());
      await expect(task.result).rejects.toBeDefined();
    }
    expect(peer.requests).toEqual([]);
  });
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: interrupting one pi-ai read poisons that subscription while its owner stays alive`, async () => {
    const peer = createPiAiStreamRig({ events: [], result: text, pauseAfter: 0 });
    const provider = createPiAiProvider(runtime, { model, stream: peer.stream });
    const controller = new AbortController();
    const task = runtime.start(function* () {
      const reader = yield* provider.stream(request);
      yield* runtime.composition.catchError(
        () => runtime.withSignal(controller.signal, () => reader.next()),
        function* () {
          return undefined;
        },
      );
      return yield* reader.next();
    });
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    await Promise.race([peer.peer.waitForRequests(1), task.result]);
    controller.abort(new Error("stop read"));
    await expect(task.result).rejects.toThrow("Model request aborted");
    expect(peer.requests).toHaveLength(1);
    expect(peer.released).toBe(1);
    expect(peer.peer.aborted).toEqual(["sdk"]);
  });
});
