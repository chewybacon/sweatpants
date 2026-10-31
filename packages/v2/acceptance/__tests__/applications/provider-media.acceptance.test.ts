import { expect, it, onTestFinished } from "vitest";
import {
  createPiAiProvider,
  describePiAiModel,
  createPiAiImageProvider,
  type PiAiProviderOptions,
  type PiAiImageProviderOptions,
} from "@sweatpan.ts/providers-pi-ai";
import {
  measureContextBudget,
  type ChatImageContentPart,
  type ModelRequest,
} from "@sweatpan.ts/providers";
import { createPiAiStreamRig, createPiAiImageRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const model: PiAiProviderOptions["model"] = {
  id: "vision",
  name: "Vision",
  api: "fixture",
  provider: "test",
  baseUrl: "https://invalid.example",
  headers: { authorization: "secret" },
  reasoning: true,
  thinkingLevelMap: { max: null },
  input: ["text", "image"],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const imageModel: PiAiImageProviderOptions["model"] = {
  ...model,
  type: "image",
  output: ["image", "text"],
};
const image: ChatImageContentPart = {
  type: "image",
  source: { type: "data", mimeType: "image/png", value: "aW1hZ2U=" },
  metadata: null,
};
const usage = {
  input: 30,
  output: 10,
  reasoning: 6,
  cacheRead: 20,
  cacheWrite: 5,
  cacheWrite1h: 3,
  totalTokens: 65,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const result = {
  role: "assistant",
  content: [{ type: "text", text: "A cat" }],
  api: "fixture",
  provider: "test",
  model: "vision",
  stopReason: "stop",
  usage,
  thinkingLevel: "high",
  providerThinkingLevel: "deep",
};
const request: ModelRequest = {
  context: {
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Describe" }, image] }],
  },
  options: { thinking: "high", thinkingBudgets: { high: 512 }, maxTokens: 1024 },
};

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: vision inference exposes model limits and preserves accounting without double counting`, async () => {
    const peer = createPiAiStreamRig({ events: [], result });
    const provider = createPiAiProvider(runtime, { model, stream: peer.stream });
    const info = describePiAiModel(model);
    expect(info).not.toHaveProperty("headers");
    expect(info).not.toHaveProperty("baseUrl");
    expect(info.reasoningLevels).not.toContain("max");
    expect(Object.isFrozen(info.input)).toBe(true);
    const task = runtime.start(function* () {
      const api = runtime.composition.createApi("vision", provider);
      const subscription = yield* api.operations.stream(request);
      return yield* subscription.next();
    });
    onTestFinished(() => task.cancel());
    expect(await task.result).toMatchObject({
      done: true,
      value: {
        usage: {
          input: 30,
          output: 10,
          total: 65,
          reasoning: 6,
          cacheWrite1h: 3,
          cost: { total: 10 },
        },
        reasoning: { requested: "high", provider: "deep" },
      },
    });
    expect(peer.requests[0]).toMatchObject({
      context: {
        messages: [
          {
            content: [
              { type: "text", text: "Describe" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
          },
        ],
      },
      options: { reasoning: "high", thinkingBudgets: { high: 512 }, maxTokens: 1024 },
    });
    // A count for the NEXT request must include its tools/media and new history.
    expect(measureContextBudget(info, { tokens: 7168, kind: "estimated" }, 1024)).toMatchObject({
      remaining: 0,
      fits: true,
      input: { kind: "estimated" },
    });
    expect(measureContextBudget(info, { tokens: 7169, kind: "measured" }, 1024)).toMatchObject({
      remaining: -1,
      fits: false,
    });
    expect(measureContextBudget(info, { tokens: 1, kind: "measured" }, 2048).fits).toBe(false);
    expect(
      measureContextBudget(
        { contextWindow: null, maxOutputTokens: null },
        { tokens: 30, kind: "estimated" },
        100,
      ),
    ).toMatchObject({ remaining: null, fits: null });
    expect(() => measureContextBudget(info, { tokens: NaN, kind: "estimated" }, 100)).toThrow();
  });

  it(`${runtime.name}: model capability and token limits reject before inference`, async () => {
    const peer = createPiAiStreamRig({ events: [], result });
    const provider = createPiAiProvider(runtime, { model, stream: peer.stream });
    for (const options of [
      { thinking: "max" as const },
      { maxTokens: 1025 },
      { thinkingBudgets: { high: -1 } },
    ]) {
      const task = runtime.start(() => provider.stream({ ...request, options }));
      onTestFinished(() => task.cancel());
      await expect(task.result).rejects.toThrow();
    }
    const textOnly = createPiAiProvider(runtime, {
      model: { ...model, input: ["text"] },
      stream: peer.stream,
    });
    const task = runtime.start(() => textOnly.stream(request));
    onTestFinished(() => task.cancel());
    await expect(task.result).rejects.toThrow("Unsupported pi-ai input modality");
    expect(peer.requests).toHaveLength(0);
  });

  it(`${runtime.name}: image generation accepts inline source images and preserves output and unknown usage`, async () => {
    const peer = createPiAiImageRig({
      api: "image-api",
      provider: "test",
      model: "image",
      stopReason: "stop",
      responseId: "image-1",
      output: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    });
    const provider = createPiAiImageProvider(runtime, {
      model: imageModel,
      generate: peer.generate,
    });
    const task = runtime.start(function* () {
      const api = runtime.composition.createApi("images", provider);
      return yield* api.operations.generate({
        input: [{ type: "text", text: "Redraw" }, image],
      });
    });
    onTestFinished(() => task.cancel());
    expect(await task.result).toEqual({
      output: [image],
      source: { api: "image-api", provider: "test", model: "image", responseModel: null },
      usage: null,
      responseId: "image-1",
    });
    expect(peer.requests[0]).toMatchObject({
      context: {
        input: [
          { type: "text", text: "Redraw" },
          { type: "image", data: "aW1hZ2U=" },
        ],
      },
    });
    expect(peer.released).toBe(1);
  });

  it(`${runtime.name}: image generation cancellation reaches the pending SDK operation`, async () => {
    const peer = createPiAiImageRig(undefined, true);
    const provider = createPiAiImageProvider(runtime, {
      model: imageModel,
      generate: peer.generate,
    });
    const task = runtime.start(() => provider.generate({ input: "Draw" }));
    onTestFinished(() => task.cancel());
    await Promise.race([peer.peer.waitForRequests(1), task.result]);
    await task.cancel();
    expect(peer.signals[0]?.aborted).toBe(true);
    expect(peer.peer.aborted).toEqual(["image"]);
    expect(peer.released).toBe(1);
  });

  it(`${runtime.name}: failed image generation never manufactures a successful result`, async () => {
    for (const raw of [
      undefined,
      { api: "image", provider: "test", model: "image", output: [], stopReason: "error" },
    ]) {
      const peer = createPiAiImageRig(raw);
      const provider = createPiAiImageProvider(runtime, {
        model: imageModel,
        generate: peer.generate,
      });
      const task = runtime.start(() => provider.generate({ input: "Draw" }));
      onTestFinished(() => task.cancel());
      await expect(task.result).rejects.toThrow("Invalid or failed pi-ai image response");
    }
  });
});
