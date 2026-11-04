import { expect, it, onTestFinished } from "vitest";
import {
  prepareChatInference,
  createChatContext,
  type ChatInferenceOptions,
  type ChatHistoryMessage,
} from "@sweatpan.ts/chat";
import {
  createPiAiProvider,
  describePiAiModel,
  type PiAiProviderOptions,
} from "@sweatpan.ts/providers-pi-ai";
import { createPiAiStreamRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
const target: PiAiProviderOptions["model"] = {
  id: "target",
  name: "Target",
  provider: "test",
  api: "fixture",
  baseUrl: "https://invalid.example",
  input: ["text"],
  reasoning: true,
  thinkingLevelMap: { max: null, off: null },
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const origin = { id: "origin", provider: "test", api: "fixture" };
const history: ChatHistoryMessage[] = [
  { role: "system", content: "Keep the instructions" },
  { role: "user", content: "Check" },
  {
    role: "assistant",
    model: origin,
    content: [
      { type: "text", text: "Checking" },
      {
        type: "reasoning",
        text: "private",
        format: null,
        signature: "reasoning-signature",
        redacted: true,
      },
      {
        type: "tool-call",
        toolCall: { id: "call", name: "check", input: {}, thoughtSignature: "tool-signature" },
      },
    ],
  },
  { role: "tool", toolCallId: "call", name: "check", isError: false, content: "done" },
];
const terminal = {
  role: "assistant",
  content: [{ type: "text", text: "Complete" }],
  api: "fixture",
  provider: "test",
  model: "target",
  stopReason: "stop",
  usage: {
    input: 10,
    output: 2,
    totalTokens: 12,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: context preparation composes scoped strategies, contexts and replacement drivers`, async () => {
    const context = createChatContext(runtime.composition, "context-preparation");
    const retained = runtime.composition.createContext<number>("retained-messages");
    const input: ChatInferenceOptions = {
      model: describePiAiModel(target),
      history: [...history, { role: "user", content: "Next question" }],
      tools: [],
      foreignReasoning: "omit",
    };
    const original = structuredClone(input);
    const observations: number[] = [];
    const task = runtime.start(function* () {
      const baseline = yield* context.operations.prepare(input);
      expect(baseline).toEqual(prepareChatInference(input));
      yield* runtime.composition.scoped(function* () {
        yield* context.around({
          operations: {
            prepare: (next) =>
              function* (request) {
                const result = yield* next(request);
                observations.push(result.request.context.messages.length);
                return result;
              },
          },
        });
        yield* runtime.composition.scoped(function* () {
          yield* retained.set(1);
          yield* context.around({
            operations: {
              prepare: (next) =>
                function* (request) {
                  const count = yield* retained.expect();
                  const instructions = request.history.filter(
                    (message) => message.role === "system" || message.role === "developer",
                  );
                  // This example's last message is a complete user turn. The default
                  // assembler still rejects windows that leave orphaned tool results.
                  const conversation = request.history.filter(
                    (message) => message.role !== "system" && message.role !== "developer",
                  );
                  return yield* next({
                    ...request,
                    history: [...instructions, ...conversation.slice(-count)],
                  });
                },
            },
          });
          const windowed = yield* context.operations.prepare(input);
          expect(windowed.request.context.messages).toEqual([history[0], input.history.at(-1)]);
          yield* runtime.composition.scoped(function* () {
            yield* retained.set(2);
            yield* runtime.composition.catchError(
              function* () {
                yield* context.operations.prepare(input);
                throw new Error("Expected invalid window");
              },
              function* (error) {
                expect(String(error)).toContain("Tool result does not match");
              },
            );
          });
        });
        expect(yield* context.operations.prepare(input)).toEqual(baseline);
        yield* runtime.composition.scoped(function* () {
          yield* context.install({
            operations: {
              *prepare(request) {
                return prepareChatInference({ ...request, options: { maxTokens: 32 } });
              },
            },
          });
          expect((yield* context.operations.prepare(input)).request.options).toEqual({
            maxTokens: 32,
          });
        });
      });
      expect(yield* context.operations.prepare(input)).toEqual(baseline);
      expect(observations).toEqual([
        2,
        baseline.request.context.messages.length,
        baseline.request.context.messages.length,
      ]);
    });
    onTestFinished(() => task.cancel());
    await task.result;
    expect(input).toEqual(original);
  });
  it(`${runtime.name}: context assembly applies explicit cross-model policy before SDK dispatch without changing accepted history`, async () => {
    const peer = createPiAiStreamRig({ events: [], result: terminal });
    const provider = createPiAiProvider(runtime, { model: target, stream: peer.stream });
    const preparation = createChatContext(runtime.composition, "provider-context");
    const api = runtime.composition.createApi("chat-context", {
      operations: {
        *infer(input: ChatInferenceOptions) {
          const inference = yield* preparation.operations.prepare(input);
          const subscription = yield* provider.stream(inference.request);
          return yield* subscription.next();
        },
      },
    });
    const original = structuredClone(history);
    const input: ChatInferenceOptions = { model: describePiAiModel(target), history, tools: [] };
    const rejected = runtime.start(() => api.operations.infer(input));
    onTestFinished(() => rejected.cancel());
    await expect(rejected.result).rejects.toThrow("explicit compatibility policy");
    expect(peer.requests).toHaveLength(0);
    const allowed = runtime.start(() =>
      api.operations.infer({ ...input, foreignReasoning: "omit" }),
    );
    onTestFinished(() => allowed.cancel());
    expect(await allowed.result).toMatchObject({
      done: true,
      value: { message: { content: [{ type: "text", text: "Complete" }] } },
    });
    expect(peer.requests[0]?.context).toMatchObject({
      systemPrompt: "Keep the instructions",
      messages: [
        { role: "user", content: [{ type: "text", text: "Check" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking" },
            {
              type: "toolCall",
              id: "call",
              name: "check",
              arguments: {},
              thoughtSignature: undefined,
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "check",
          content: [{ type: "text", text: "done" }],
        },
      ],
    });
    expect(history).toEqual(original);
    // Same-model continuation preserves signatures, even when omission is allowed for foreign history.
    const localHistory = history.map((message) =>
      message.role === "assistant"
        ? { ...message, model: { id: target.id, provider: target.provider, api: target.api } }
        : message,
    );
    const local = runtime.start(() =>
      api.operations.infer({ ...input, history: localHistory, foreignReasoning: "omit" }),
    );
    onTestFinished(() => local.cancel());
    await local.result;
    expect(peer.requests[1]?.context).toMatchObject({
      messages: [
        { role: "user" },
        {
          role: "assistant",
          content: [
            { type: "text" },
            { type: "thinking", thinkingSignature: "reasoning-signature" },
            { type: "toolCall", thoughtSignature: "tool-signature" },
          ],
        },
        { role: "toolResult" },
      ],
    });
  });
  it(`${runtime.name}: invalid round boundaries and incompatible model inputs never reach inference`, async () => {
    const peer = createPiAiStreamRig({ events: [], result: terminal });
    const provider = createPiAiProvider(runtime, { model: target, stream: peer.stream });
    const base: ChatInferenceOptions = {
      model: describePiAiModel(target),
      history,
      tools: [],
      foreignReasoning: "omit",
    };
    const invalid: ChatInferenceOptions[] = [
      { ...base, history: history.slice(0, -1) },
      { ...base, history: [...history.slice(0, -1), { role: "user", content: "interrupt" }] },
      {
        ...base,
        history: [
          ...history.slice(0, -1),
          { role: "tool", toolCallId: "call", name: "wrong", content: "done", isError: false },
        ],
      },
      { ...base, history: [...history, ...history.slice(2)] },
      {
        ...base,
        history: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" },
                metadata: null,
              },
            ],
          },
        ],
      },
      { ...base, options: { thinking: "max" } },
      { ...base, options: { thinking: "off" } },
      { ...base, options: { maxTokens: 1025 } },
    ];
    for (const input of invalid) {
      const task = runtime.start(function* () {
        const prepared = prepareChatInference(input);
        return yield* provider.stream(prepared.request);
      });
      onTestFinished(() => task.cancel());
      await expect(task.result).rejects.toThrow();
    }
    expect(peer.requests).toHaveLength(0);
  });
});
