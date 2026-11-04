import { expect, it, onTestFinished } from "vitest";
import {
  createChatModel,
  createChatSampling,
  limitChatRounds,
  type ChatLoopRequest,
} from "@sweatpan.ts/chat";
import type { ModelInfo, ModelResponse } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

const parent: ModelInfo = {
  id: "parent",
  name: "Parent",
  provider: "script",
  api: "script",
  input: ["text"],
  output: ["text"],
  contextWindow: 1000,
  maxOutputTokens: 100,
  reasoningLevels: [],
};
const request: ChatLoopRequest = { round: 0, history: [], tools: [] };
function response(tool: boolean): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: tool
        ? [
            {
              type: "tool-call",
              toolCall: { id: "call", name: "tool", input: null, thoughtSignature: null },
            },
          ]
        : [{ type: "text", text: "Done" }],
    },
    source: null,
    usage: null,
    stopReason: null,
    responseId: null,
    errorMessage: null,
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: scoped sampling policy isolates sibling models and limits and restores parent policy`, async () => {
    let selections = 0;
    let samples = 0;
    const models = createChatModel(runtime.composition, "policy.model", {
      *select() {
        selections++;
        return parent;
      },
    });
    const sampling = createChatSampling(runtime.composition, "policy.sample", {
      model: models.operations,
      *sample(model, input) {
        samples++;
        return { model, response: response(input.round === 0) };
      },
    });
    const task = runtime.start(function* () {
      yield* sampling.around(limitChatRounds(4));
      const results = yield* runtime.all([
        function* () {
          yield* models.install({
            *select() {
              selections++;
              return { ...parent, id: "child" };
            },
          });
          yield* sampling.around(limitChatRounds(1));
          return yield* sampling.operations.sample(request);
        },
        function* () {
          return yield* sampling.operations.sample(request);
        },
      ]);
      expect(results[0]).toMatchObject({
        ok: false,
        error: { code: "round-limit", sample: { model: { id: "child" } } },
      });
      expect(results[1]).toMatchObject({ ok: true, value: { model: { id: "parent" } } });
      expect(yield* sampling.operations.sample(request)).toMatchObject({
        ok: true,
        value: { model: { id: "parent" } },
      });
      expect(selections).toBe(3);
      expect(samples).toBe(3);
      // A round outside the configured budget never resolves a model or dispatches.
      expect(yield* sampling.operations.sample({ ...request, round: 4 })).toMatchObject({
        ok: false,
        error: { code: "round-limit" },
      });
      expect(yield* sampling.operations.sample({ ...request, round: -1 })).toMatchObject({
        ok: false,
        error: { code: "invalid-round" },
      });
      expect(samples).toBe(3);
      expect(selections).toBe(3);
      // The last permitted round can return a final answer.
      expect(yield* sampling.operations.sample({ ...request, round: 3 })).toMatchObject({
        ok: true,
      });
      // Driver replacement still retains inherited sampling middleware.
      yield* runtime.composition.scoped(function* () {
        yield* sampling.install({
          *sample() {
            return { ok: true, value: { model: parent, response: response(true) } };
          },
        });
        expect(yield* sampling.operations.sample({ ...request, round: 3 })).toMatchObject({
          ok: false,
          error: { code: "round-limit" },
        });
      });
      expect(yield* sampling.operations.sample({ ...request, round: 3 })).toMatchObject({
        ok: true,
      });
    });
    onTestFinished(() => task.cancel());
    await task.result;
    for (const invalid of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => limitChatRounds(invalid)).toThrow("Invalid chat round limit");
    }
  });

  it(`${runtime.name}: cancellation during model selection never dispatches inference`, async () => {
    const peer = createProtocolRig();
    let samples = 0;
    const models = createChatModel(runtime.composition, "selection.model", {
      *select() {
        yield* runtime.fromPromise((signal) => peer.send({ id: "select", token: "model" }, signal));
        return parent;
      },
    });
    const sampling = createChatSampling(runtime.composition, "selection.sample", {
      model: models.operations,
      *sample(model) {
        samples++;
        return { model, response: response(false) };
      },
    });
    const task = runtime.start(() => sampling.operations.sample(request));
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    await Promise.race([peer.waitForRequests(1), task.result]);
    await task.cancel();
    expect(samples).toBe(0);
    expect(peer.aborted).toHaveLength(1);
  });
});
