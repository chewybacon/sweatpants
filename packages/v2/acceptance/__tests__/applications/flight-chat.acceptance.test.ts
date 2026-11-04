import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Work } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import {
  createChatContext,
  createChatModel,
  createChatSampling,
  type ChatInference,
  type ChatLoopResult,
} from "@sweatpan.ts/chat";
import { createChatToolBinding } from "@sweatpan.ts/chat-host";
import {
  createModelProvider,
  type ModelInfo,
  type ModelResponse,
  type ModelStreamEvent,
} from "@sweatpan.ts/providers";
import { createPullStream, type Runtime } from "@sweatpan.ts/runtime";
import {
  createHostedRecovery,
  createSqliteJournalRig,
  createProtocolRig,
} from "@sweatpan.ts/testing";
import type { ToolInteraction } from "@sweatpan.ts/tools";
import {
  chooseFlight,
  flightChat,
  flightInput,
  flightResult,
  itineraryResult,
  saveItinerary,
  saveItineraryRecord,
  searchFlights,
  travelTip,
} from "../../examples/flight-chat.ts";
import { forEachRuntime } from "../runtime/assembly.ts";
const planner: ModelInfo = {
  id: "planner",
  name: "Planner",
  provider: "scripted",
  api: "scripted",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: [],
};
const tipModel: ModelInfo = { ...planner, id: "travel", name: "Travel" };
function response(content: ModelResponse["message"]["content"]): ModelResponse {
  return {
    message: { role: "assistant", content },
    source: null,
    usage: null,
    stopReason: null,
    responseId: null,
    errorMessage: null,
  };
}
const initial = response([
  {
    type: "tool-call",
    toolCall: {
      id: "booking",
      name: "choose_flight",
      input: { destination: "LAX" },
      thoughtSignature: null,
    },
  },
]);
const tip = response([{ type: "text", text: "Take the airport shuttle." }]);
const itinerary = response([
  {
    type: "tool-call",
    toolCall: {
      id: "itinerary",
      name: "save_itinerary",
      input: { flight: "flight-1", seat: "2A" },
      thoughtSignature: null,
    },
  },
]);
const final = response([{ type: "text", text: "Your flight choices are ready." }]);
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of [
    "normal",
    "accepted-interruption",
    "provider-failure",
    "physical-stop",
  ] as const) {
    it(`${runtime.name}: authored flight choices and nested model sampling (${mode})`, async () => {
      const store = createSqliteJournalRig<
        ChatLoopResult,
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({
        program: flightChat.id,
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      const peer = createProtocolRig();
      const acknowledgement = createProtocolRig();
      const requests: ChatInference[] = [];
      const selections: string[] = [];
      let searches = 0;
      let saves = 0;
      let acquired = 0;
      let released = 0;
      let interrupted = false;
      let selectedTip = tipModel;
      function task<T>(work: Work<T, Y>) {
        const result = runtime.start(work);
        void result.result.catch(() => undefined);
        onTestFinished(() => result.cancel());
        return result;
      }
      const models = createChatModel(runtime.composition, "flight-model", {
        *select() {
          selections.push(planner.id);
          return planner;
        },
      });
      const context = createChatContext(runtime.composition, "flight-context");
      const provider = createModelProvider<Y, ChatInference>(
        runtime.composition,
        "flight-provider",
        {
          stream(inference) {
            let started = false;
            return createPullStream<ModelStreamEvent, ModelResponse, Y, Y>(
              runtime.composition,
              () =>
                function* () {
                  if (!started) {
                    started = true;
                    acquired++;
                    yield* runtime.composition.ensure(function* () {
                      released++;
                    });
                    return {
                      done: false,
                      value: { type: "start", partial: { role: "assistant", content: [] } },
                    };
                  }
                  const index = requests.length;
                  requests.push(structuredClone(inference));
                  const reply = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: `model-${index}`, token: inference.model.id }, signal),
                  );
                  // The scripted peer selects typed fixtures; arbitrary provider bytes aren't trusted as a response.
                  const fixture = z
                    .enum(["initial", "tip", "itinerary", "final"])
                    .parse(reply.body);
                  return {
                    done: true,
                    value: structuredClone({ initial, tip, itinerary, final }[fixture]),
                  };
                },
            );
          },
        },
      );
      const sampling = createChatSampling(runtime.composition, "flight-sampling", {
        model: models.operations,
        *sample(model, request) {
          const inference = yield* context.operations.prepare({
            model,
            history: request.history,
            tools: request.tools,
            options: { maxTokens: model.id === planner.id ? 512 : 100 },
          });
          return yield* runtime.composition.scoped(function* () {
            const stream = yield* provider.operations.stream(inference);
            while (true) {
              const item = yield* stream.next();
              if (item.done) {
                return { model: inference.model, response: item.value };
              }
              // Provider events are provisional, not accepted samples or tool results.
            }
          });
        },
      });
      function bind() {
        const recovery = <R>(
          options: Parameters<
            typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
          >[1],
        ) => createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, options);
        const choose = createChatToolBinding(runtime, chooseFlight, {
          definition: {
            name: "choose_flight",
            description: "Choose a flight and seat with a travel tip.",
            parameters: z.record(z.string(), z.json()).parse(z.toJSONSchema(flightInput)),
          },
          recovery,
          matches: isDeepStrictEqual,
          *configure({ host, effects }) {
            yield* effects.install(searchFlights, function* () {
              searches++;
              return {
                ok: true,
                value: [
                  { id: "flight-1", airline: "SkyHigh" },
                  { id: "flight-2", airline: "CloudAir" },
                ],
              };
            });
            yield* effects.install(travelTip, function* ({ destination }) {
              return yield* runtime.composition.scoped(function* () {
                yield* models.install({
                  operations: {
                    *select() {
                      selections.push(selectedTip.id);
                      return selectedTip;
                    },
                  },
                });
                // This is one application-owned inference, not recursion into the outer chat loop.
                const sampled = yield* sampling.operations.sample({
                  round: 0,
                  tools: [],
                  history: [
                    {
                      role: "user",
                      content: `Give a brief travel tip for ${destination} airport.`,
                    },
                  ],
                });
                if (!sampled.ok) {
                  throw new Error(sampled.error.message);
                }
                if (
                  sampled.value.response.message.content.some((part) => part.type === "tool-call")
                ) {
                  throw new Error("Travel tips cannot invoke tools");
                }
                return {
                  ok: true,
                  value: {
                    model: sampled.value.model,
                    text: sampled.value.response.message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join(""),
                  },
                };
              });
            });
            yield* host.attempts.around({
              operations: {
                settle: (next) =>
                  function* (...args) {
                    const accepted = yield* next(...args);
                    if (
                      mode === "accepted-interruption" &&
                      accepted.entry.request.effect === travelTip.id &&
                      !interrupted
                    ) {
                      interrupted = true;
                      yield* runtime.fromPromise((signal) =>
                        acknowledgement.send({ id: "accepted-tip", token: "hold" }, signal),
                      );
                    }
                    return accepted;
                  },
              },
            });
          },
        });
        const save = createChatToolBinding(runtime, saveItinerary, {
          definition: {
            name: "save_itinerary",
            description: "Save the selected flight and seat.",
            parameters: {
              type: "object",
              properties: { flight: { type: "string" }, seat: { type: "string" } },
              required: ["flight", "seat"],
              additionalProperties: false,
            },
          },
          recovery,
          matches: isDeepStrictEqual,
          *configure({ effects }) {
            yield* effects.install(saveItineraryRecord, function* (input) {
              saves++;
              return { ok: true, value: { id: `${input.flight}:${input.seat}` } };
            });
          },
        });
        return flightChat.bind(runtime, {
          journal,
          tools: [choose, save],
          recovery,
          matches: isDeepStrictEqual,
          sampling: sampling.operations,
        });
      }
      let chat = bind();
      function reopen() {
        journal = store.reopen();
        chat = bind();
      }
      async function questions() {
        return await task(function* () {
          const stream = yield* chat.interactions();
          const items: ToolInteraction[] = [];
          while (true) {
            const item = yield* stream.next();
            if (item.done) {
              return items;
            }
            items.push(item.value);
          }
        }).result;
      }
      await task(() => journal.admit(flightChat.id, { prompt: "Help choose my flight." })).result;
      const beginning = task(chat.run);
      await Promise.race([peer.waitForRequests(1), beginning.result]);
      peer.reply("model-0", { status: 200, body: "initial" });
      expect(await beginning.result).toMatchObject({ state: "child", reason: "waiting" });
      expect(searches).toBe(1);
      reopen();
      const [flight] = await questions();
      expect(flight!.input).toEqual([
        { id: "flight-1", airline: "SkyHigh" },
        { id: "flight-2", airline: "CloudAir" },
      ]);
      await task(() => chat.answer(flight!, { ok: true, value: "flight-1" })).result;
      expect(await task(chat.run).result).toMatchObject({ state: "child", reason: "waiting" });
      reopen();
      const [seat] = await questions();
      expect(seat!.input).toEqual({ flight: "flight-1", seats: ["2A", "2B"] });
      await expect(
        task(() => chat.answer(seat!, { ok: true, value: "99Z" })).result,
      ).rejects.toThrow();
      await task(() => chat.answer(seat!, { ok: true, value: "2A" })).result;
      expect(peer.requests).toHaveLength(1); // Answers never start advancement.
      reopen();
      const nested = task(chat.run);
      await Promise.race([peer.waitForRequests(2), nested.result]);
      expect(requests[1]).toMatchObject({
        model: { id: "travel" },
        request: {
          context: {
            messages: [{ role: "user", content: "Give a brief travel tip for LAX airport." }],
            tools: [],
          },
          options: { maxTokens: 100 },
        },
      });
      expect(requests[1]!.request.context.messages).toHaveLength(1);
      if (mode === "provider-failure" || mode === "physical-stop") {
        if (mode === "provider-failure") {
          peer.fail("model-1", new Error("Provider connection lost"));
          await expect(nested.result).rejects.toThrow("Provider connection lost");
        } else {
          await nested.cancel();
          expect(peer.aborted).toContain("model-1");
        }
        reopen();
        expect(await task(chat.run).result).toMatchObject({ state: "child", reason: "occupied" });
        expect(peer.requests).toHaveLength(2);
        expect(searches).toBe(1);
        expect((await task(journal.read).result).status).toBe("running");
        expect(await questions()).toEqual([]);
        expect(released).toBe(acquired);
        return;
      }
      peer.reply("model-1", { status: 200, body: "tip" });
      let finishing = nested;
      if (mode === "accepted-interruption") {
        await Promise.race([acknowledgement.waitForRequests(1), nested.result]);
        await nested.cancel();
        expect(peer.requests).toHaveLength(2);
        selectedTip = { ...tipModel, id: "replacement-travel" };
        reopen();
        finishing = task(chat.run);
      }
      await Promise.race([peer.waitForRequests(3), finishing.result]);
      expect(requests[2]!.model.id).toBe("planner");
      expect(requests[2]!.request.context.tools.map((entry) => entry.name)).toEqual([
        "choose_flight",
        "save_itinerary",
      ]);
      const results = requests[2]!.request.context.messages.filter(
        (message) => message.role === "tool",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ toolCallId: "booking", isError: false });
      const booked = flightResult.parse(JSON.parse(z.string().parse(results[0]!.content)));
      expect(booked).toEqual({
        flight: "flight-1",
        seat: "2A",
        destination: "LAX",
        tip: {
          text: "Take the airport shuttle.",
          model: { id: "travel", provider: "scripted", api: "scripted" },
        },
      });
      type AuthoredResult =
        ReturnType<typeof chooseFlight.body> extends Operation<infer R, unknown> ? R : never;
      expectTypeOf<AuthoredResult>().toEqualTypeOf<z.infer<typeof flightResult>>();
      expect(selections).toEqual(["planner", "travel", "planner"]);
      peer.reply("model-2", { status: 200, body: "itinerary" });
      expect(await finishing.result).toMatchObject({ state: "child", reason: "waiting" });
      reopen();
      const [confirmation] = await questions();
      expect(confirmation).toMatchObject({
        program: saveItinerary.id,
        input: { flight: "flight-1", seat: "2A" },
      });
      await task(() => chat.answer(confirmation!, { ok: true, value: "save" })).result;
      expect(saves).toBe(0);
      reopen();
      const completed = task(chat.run);
      await Promise.race([peer.waitForRequests(4), completed.result]);
      expect(requests[3]!.request.context.tools.map((entry) => entry.name)).toEqual([
        "choose_flight",
        "save_itinerary",
      ]);
      const finalResults = requests[3]!.request.context.messages.filter(
        (message) => message.role === "tool",
      );
      expect(finalResults.map((message) => message.toolCallId)).toEqual(["booking", "itinerary"]);
      expect(itineraryResult.parse(JSON.parse(z.string().parse(finalResults[1]!.content)))).toEqual(
        { saved: true, itinerary: { id: "flight-1:2A" } },
      );
      expect(saves).toBe(1);
      expect(selections).toEqual(["planner", "travel", "planner", "planner"]);
      peer.reply("model-3", { status: 200, body: "final" });
      expect(await completed.result).toMatchObject({ state: "completed" });
      reopen();
      expect(await task(chat.run).result).toMatchObject({ state: "completed" });
      expect(peer.requests).toHaveLength(4);
      expect(searches).toBe(1);
      expect(saves).toBe(1);
      expect(released).toBe(acquired);
    });
  }
});
