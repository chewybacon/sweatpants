import { local } from "@sweatpants/tool-runtime-local";
import { URL as NodeURL } from "node:url";
import { fireEvent } from "@testing-library/react";
import { useUI } from "../../support/ui.tsx";
import { bookFlightPlugin } from "../../../apps/yo-chat/src/tools/book-flight/plugin.ts";
import { pickCardPlugin } from "../../../apps/yo-chat/src/tools/pick-card/plugin.ts";
import { playTttPlugin } from "../../../apps/yo-chat/src/tools/play-ttt/plugin.ts";
import { tictactoePlugin } from "../../../apps/yo-chat/src/tools/tictactoe/plugin.ts";
import { askQuestionPlugin } from "../../../apps/yo-chat/src/tools/general/ask-question/plugin.ts";
import { tools } from "../../../apps/yo-chat/src/server/tool-definitions.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { createPrimitiveChatApp } from "@sweatpants/agent-host/primitive";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, race, spawn, resource, type Operation } from "effection";
import { describe, expect, it, vi } from "vitest";
import { withTestScenario, type ScenarioContext } from "@sweatpants/test-rig";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { createChatClient, makePlugin, type ReactChatClient } from "@sweatpants/react-chat";
import { createLocalYoChatApplication } from "../../../apps/yo-chat/src/server/local-chat-application.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

vi.mock("../../../packages/agent-host/src/server/index.ts", async (original) => ({
  ...(await original<object>()),
  createChatApp() {
    throw new Error("Legacy chat owner invoked");
  },
}));
vi.mock("../../../packages/agent-host/src/server/tool-execution.ts", () => ({
  prepareChatTools() {
    throw new Error("Legacy tool preparation invoked");
  },
}));
vi.mock("../../../packages/durable-chat-runtime/src/durable-handler/chat-execution.ts", () => ({
  executeChatTurn() {
    throw new Error("Legacy chat execution invoked");
  },
}));

function clientFor(rig: ScenarioContext, threadId = "math"): Operation<ReactChatClient> {
  return resource(function* (provide) {
    const client = createChatClient({
      threadId,
      transport: { http: { api: "/api/chat", fetch: rig.transport.fetch } },
    });
    try {
      yield* call(() => client.initialized);
      yield* provide(client);
    } finally {
      yield* call(() => client.close());
    }
  });
}
function outputs(input: unknown) {
  if (!Array.isArray(input)) {
    throw new Error("Expected provider input array");
  }
  return input
    .filter((item) => item.type === "function_call_output")
    .map((item) => ({ id: item.call_id, output: JSON.parse(item.output) }));
}

describe.each(["in-process", "worker"] as const)("yo-chat %s placement", (placement) => {
  async function scenario(work: (rig: ScenarioContext) => Operation<void>) {
    const directory = await mkdtemp(join(tmpdir(), "yo-chat-local-"));
    try {
      await withTestScenario(
        {
          binding: "http",
          createApplication: (context) => {
            const app = createLocalYoChatApplication({
              database: join(directory, "chat.sqlite"),
              // CONDITIONAL-SPREAD: the in-process scenario exercises the omitted-placement default.
              ...(placement === "worker"
                ? {
                    execution: local({
                      worker: new NodeURL(
                        "../../../apps/yo-chat/src/server/journal-tool-worker-bootstrap.mjs",
                        import.meta.url,
                      ),
                      execArgv: ["--conditions=development"],
                    }),
                  }
                : {}),
              model: {
                identity: "scripted",
                model: context.model.model,
                driver: createPiAiModelProvider().driver,
                streamOptions: context.model.streamOptions,
              },
            });
            return {
              handle: (request: Request) => {
                // The rig's conversation helper uses /assistant/chat; only adapt its URL.
                const url = new URL(request.url);
                url.pathname = url.pathname.replace(/^\/assistant\/chat/, "/api/chat");
                return app.handler(new Request(url, request));
              },
              close: app.close,
            };
          },
        },
        work,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("actual local yo-chat streams, correlates every call, repeats the loop and reconnects to one running inference", async () => {
    for (const plugin of [
      bookFlightPlugin,
      pickCardPlugin,
      playTttPlugin,
      tictactoePlugin,
      askQuestionPlugin,
    ]) {
      const tool = tools.find((item) => item.name === plugin.client.toolName)!;
      expect(plugin.client.ownerInterfaceDigest).toBe(tool.interfaceDigest);
      for (const [id, binding] of plugin.client.bindings) {
        expect(tool.bindings.elicits[binding.key]).toEqual({ id });
        expect(binding.artifacts).toEqual(tool.artifacts.elicits[binding.key]);
      }
    }
    await scenario(function* (rig) {
      const client = yield* clientFor(rig);
      const sending = yield* spawn(() =>
        call(() => client.sendMessage("Compute 42 * 17 and 2 + 2")),
      );
      const first = yield* race([
        rig.model.request(),
        (function* () {
          const failed = yield* waitForSnapshot(client, (state) => state.error !== null);
          throw new Error(failed.error?.message ?? "Chat failed");
        })(),
      ]);
      expect(
        (first.body.tools as Array<{ name: string }>)
          .map((tool: { name: string }) => tool.name)
          .sort(),
      ).toEqual([
        "ask_question",
        "book_flight",
        "calculator",
        "pick_card",
        "play_ttt",
        "tictactoe",
      ]);
      yield* first.respond.toolCalls(
        [
          { id: "multiply", name: "calculator", arguments: { expression: "42 * 17" } },
          { id: "add", name: "calculator", arguments: { expression: "2 + 2" } },
        ],
        { argumentChunkSize: 2 },
      );
      const second = yield* rig.model.request();
      expect(outputs(second.body.input)).toEqual([
        { id: "multiply", output: { expression: "42 * 17", result: 714, error: null } },
        { id: "add", output: { expression: "2 + 2", result: 4, error: null } },
      ]);
      yield* second.respond.toolCalls([
        { id: "subtract", name: "calculator", arguments: { expression: "714 - 4" } },
      ]);
      const final = yield* rig.model.request();
      expect(outputs(final.body.input).at(-1)).toEqual({
        id: "subtract",
        output: { expression: "714 - 4", result: 710, error: null },
      });
      const stream = yield* final.respond.textStream(["The result is ", "710."]);
      yield* stream.releaseNext();
      yield* waitForSnapshot(client, (state) =>
        JSON.stringify(state.messages).includes("The result is "),
      );
      const reconnecting = yield* spawn(() => clientFor(rig));
      yield* stream.finish();
      yield* sending;
      const secondClient = yield* reconnecting;
      expect(JSON.stringify(secondClient.getSnapshot().messages)).toContain("The result is 710.");
      expect(rig.model.requests()).toHaveLength(3);
      const follow = yield* spawn(() => call(() => client.sendMessage("Remember the result")));
      const next = yield* rig.model.request();
      expect(outputs(next.body.input)).toHaveLength(3);
      yield* next.respond.text("The result was 710.");
      yield* follow;
      expect(client.getSnapshot().error).toBeNull();
    });
  });

  it("Stop aborts the provider, settles cancellation and permits another turn", async () => {
    await scenario(function* (rig) {
      const client = yield* clientFor(rig);
      const sending = yield* spawn(() => call(() => client.sendMessage("Compute 6 * 7")));
      const first = yield* rig.model.request();
      yield* first.respond.toolCalls([
        { id: "answer", name: "calculator", arguments: { expression: "6 * 7" } },
      ]);
      const final = yield* rig.model.request();
      const aborted = yield* spawn(() => final.respond.awaitAbort());
      yield* call(() => client.stop());
      yield* aborted;
      yield* sending;
      expect(client.getSnapshot().authority?.state).toBe("idle");
      const follow = yield* spawn(() => call(() => client.sendMessage("Continue")));
      const next = yield* rig.model.request();
      yield* next.respond.text("Ready again.");
      yield* follow;
      expect(client.getSnapshot().error).toBeNull();
    });
  });

  it("non-finite arithmetic is a visible execution failure, never a success-shaped null", async () => {
    await scenario(function* (rig) {
      const client = yield* clientFor(rig);
      const sending = yield* spawn(() => call(() => client.sendMessage("Divide by zero")));
      const first = yield* rig.model.request();
      yield* first.respond.toolCalls([
        { id: "infinite", name: "calculator", arguments: { expression: "1 / 0" } },
      ]);
      yield* sending;
      expect(client.getSnapshot().error).toMatchObject({ code: "EXECUTION_FAILED" });
      expect(rig.model.requests()).toHaveLength(1);
    });
  });

  for (const action of ["accept", "decline", "cancel"] as const) {
    it(`ask_question preserves ${action} through the public client`, async () => {
      await scenario(function* (rig) {
        const conversation = rig.conversation();
        const turn = yield* conversation.send("Ask me");
        const first = yield* rig.model.request();
        yield* first.respond.toolCalls([
          { id: "question", name: "ask_question", arguments: { question: "Ready?" } },
        ]);
        const question = yield* turn.elicit("askQuestion");
        if (action === "accept") {
          yield* question.accept({ answer: "Yes" });
        } else if (action === "decline") {
          yield* question.decline();
        } else {
          yield* question.cancel();
        }
        const final = yield* rig.model.request();
        expect(outputs(final.body.input)).toEqual([
          {
            id: "question",
            output:
              action === "accept"
                ? { question: "Ready?", answer: "Yes" }
                : { question: "Ready?", answer: null, cancelled: true },
          },
        ]);
        yield* final.respond.text("Question settled.");
        yield* turn.settled();
      });
    });
  }

  it("flight preserves both choices and a nested sample in the same turn", async () => {
    await scenario(function* (rig) {
      using ui = yield* useUI(rig, { plugins: [bookFlightPlugin] });
      const sending = yield* spawn(() => call(() => ui.client.sendMessage("Book a flight")));
      const first = yield* rig.model.request();
      yield* first.respond.toolCalls([
        { id: "booking", name: "book_flight", arguments: { from: "NYC", destination: "LAX" } },
      ]);
      const flight = yield* ui.waitForElement("SkyHigh flight", () =>
        ui.queryByRole<HTMLButtonElement>("button", { name: /SkyHigh Airways/ }),
      );
      flight.click();
      const seat = yield* ui.waitForEnabledButton("Seat 2A");
      seat.click();
      const confirm = yield* ui.waitForEnabledButton("Confirm Seat 2A");
      confirm.click();
      const nested = yield* rig.model.request();
      expect(JSON.stringify(nested.body.input)).toContain("LAX airport");
      yield* nested.respond.text("Take the airport shuttle.");
      const final = yield* rig.model.request();
      expect(outputs(final.body.input)).toEqual([
        {
          id: "booking",
          output: expect.objectContaining({
            success: true,
            seat: "2A",
            travelTip: "Take the airport shuttle.",
            route: { from: "NYC", to: "LAX" },
          }),
        },
      ]);
      yield* final.respond.text("Booked.");
      yield* sending;
    });
  });

  for (const name of ["play_ttt", "tictactoe"]) {
    it(`${name} alternates nested model calls and choices through the final board`, async () => {
      await scenario(function* (rig) {
        using ui = yield* useUI(rig, {
          plugins: [name === "play_ttt" ? playTttPlugin : tictactoePlugin],
        });
        const sending = yield* spawn(() => call(() => ui.client.sendMessage("Play a game")));
        const first = yield* rig.model.request();
        yield* first.respond.toolCalls([{ id: "game", name, arguments: {} }]);
        const model = yield* spawn(function* () {
          for (let moves = 0; moves < 10; moves++) {
            const request = yield* rig.model.request();
            if (outputs(request.body.input).length) {
              expect(outputs(request.body.input)).toEqual([
                {
                  id: "game",
                  output: expect.objectContaining({
                    success: true,
                    board: expect.any(Array),
                    result: expect.stringMatching(/wins|draw/),
                  }),
                },
              ]);
              yield* request.respond.text("Good game.");
              return;
            }
            const prompt = JSON.stringify(request.body.input);
            const match = prompt.match(/Empty positions: ([0-8])/);
            if (!match) {
              throw new Error("Missing legal moves in nested prompt");
            }
            yield* request.respond.text(
              name === "play_ttt" ? JSON.stringify({ cell: Number(match[1]) }) : match[1]!,
            );
          }
          throw new Error("Game did not finish");
        });
        for (let moves = 0; moves < 10; moves++) {
          const next = yield* ui.waitForElement(
            "legal move or completed game",
            () =>
              ui.queryByText("Good game.") ??
              ui
                .queryAllByRole<HTMLButtonElement>("button", { name: /^[0-8]$/ })
                .find((button) => !button.disabled) ??
              null,
          );
          if (next.textContent === "Good game.") {
            break;
          }
          next.click();
          // Wait for the selected render to settle before observing the next board.
          yield* ui.waitForElement("completed move", () =>
            next.isConnected ? null : document.body,
          );
        }
        yield* model;
        yield* sending;
        expect(JSON.stringify(ui.client.getSnapshot().messages)).toContain("gameOver");
      });
    });
  }

  it("actual card and question plugins consume the shared contracts", async () => {
    await scenario(function* (rig) {
      using ui = yield* useUI(rig, { plugins: [pickCardPlugin, askQuestionPlugin] });
      const sending = yield* spawn(() =>
        call(() => ui.client.sendMessage("Draw cards then ask me")),
      );
      const first = yield* rig.model.request();
      yield* first.respond.toolCalls([{ id: "cards", name: "pick_card", arguments: {} }]);
      yield* ui.waitForText("Pick one of these 5 cards:");
      const cards = ui
        .queryAllByRole<HTMLButtonElement>("button")
        .filter((button) => /[♠♥♦♣]/.test(button.textContent ?? ""));
      expect(cards).toHaveLength(5);
      const selected = cards[0]!.textContent!;
      cards[0]!.click();
      const question = yield* rig.model.request();
      expect(outputs(question.body.input)[0]!.output).toContain(selected);
      yield* question.respond.toolCalls([
        { id: "question", name: "ask_question", arguments: { question: "Ready?" } },
      ]);
      const answer = yield* ui.waitForElement("answer input", () =>
        ui.queryByRole<HTMLInputElement>("textbox", { name: "Answer" }),
      );
      fireEvent.change(answer, { target: { value: "Yes" } });
      const submit = yield* ui.waitForEnabledButton("Answer");
      submit.click();
      const final = yield* rig.model.request();
      expect(outputs(final.body.input).at(-1)).toEqual({
        id: "question",
        output: { question: "Ready?", answer: "Yes" },
      });
      yield* final.respond.text("Recorded.");
      yield* sending;
    });
  });

  it("Stop cancels a nested flight sample and supersession cancels a parked question", async () => {
    await scenario(function* (rig) {
      const conversation = rig.conversation();
      const flight = yield* conversation.send("Book flight");
      const first = yield* rig.model.request();
      yield* first.respond.toolCalls([
        { id: "flight-stop", name: "book_flight", arguments: { from: "NYC", destination: "LAX" } },
      ]);
      const flightChoice = yield* flight.elicit("pickFlight");
      yield* flightChoice.accept({ flightId: "FL001" });
      const seatChoice = yield* flight.elicit("pickSeat");
      yield* seatChoice.accept({ row: 2, seat: "A" });
      const nested = yield* rig.model.request();
      const aborted = yield* spawn(() => nested.respond.awaitAbort());
      yield* flight.cancel();
      yield* aborted;
      expect(conversation.snapshot().authority?.state).toBe("idle");
      const question = yield* conversation.send("Ask me");
      const ask = yield* rig.model.request();
      yield* ask.respond.toolCalls([
        { id: "parked", name: "ask_question", arguments: { question: "Continue?" } },
      ]);
      yield* question.elicit("askQuestion");
      const replacement = yield* conversation.supersede("Switch topics");
      const replacementSettled = yield* spawn(() => replacement.settled());
      const next = yield* rig.model.request();
      expect(outputs(next.body.input)).toEqual([]);
      yield* next.respond.text("New topic.");
      yield* replacementSettled;
      expect(JSON.stringify(conversation.snapshot().messages)).toContain('"state":"cancelled"');
    });
  });

  for (const prior of ["failed", "cancelled"] as const) {
    it(`${prior} turn cannot contaminate a later parked question or its answer`, async () => {
      await scenario(function* (rig) {
        const conversation = rig.conversation();
        const first = yield* conversation.send("First turn");
        const provider = yield* rig.model.request();
        if (prior === "failed") {
          yield* provider.respond.toolCalls([
            { id: "failure", name: "calculator", arguments: { expression: "1 / 0" } },
          ]);
          yield* first.failure("non-finite number");
        } else {
          const aborted = yield* spawn(() => provider.respond.awaitAbort());
          yield* first.cancel();
          yield* aborted;
        }
        const mark = rig.agui.mark();
        const second = yield* conversation.send("Ask a question");
        const asking = yield* rig.model.request();
        yield* asking.respond.toolCalls([
          {
            id: "question-after-error",
            name: "ask_question",
            arguments: { question: "Continue?" },
          },
        ]);
        const question = yield* second.elicit("askQuestion");
        yield* rig.agui.event("RUN_FINISHED", { after: mark });
        expect(conversation.snapshot().error).toBeNull();
        expect(conversation.snapshot().authority?.state).toBe("parked");
        expect(rig.agui.events(mark).at(-1)).toMatchObject({
          type: "RUN_FINISHED",
          outcome: { type: "interrupt" },
        });
        yield* question.accept({ answer: "Yes, continue" });
        const answer = yield* rig.model.request();
        expect(outputs(answer.body.input).at(-1)).toEqual({
          id: "question-after-error",
          output: { question: "Continue?", answer: "Yes, continue" },
        });
        yield* answer.respond.text("Question answered.");
        yield* second.settled();
        const follow = yield* conversation.send("Follow up");
        const next = yield* rig.model.request();
        yield* next.respond.text("Continuation works.");
        yield* follow.settled();
        expect(conversation.snapshot().error).toBeNull();
      });
    });
  }
});

it("preserves raw transformed effects, answers and context through the public chat plugin", async () => {
  const contextSchema: StandardSchemaV1<{ value: string }, { value: number }> = {
    "~standard": {
      version: 1,
      vendor: "acceptance-context",
      validate(input) {
        if (
          !input ||
          typeof input !== "object" ||
          !("value" in input) ||
          typeof input.value !== "string" ||
          !/^\d+$/.test(input.value)
        ) {
          return { issues: [{ message: "Expected numeric text context" }] };
        }
        return { value: { value: Number(input.value) + 1 } };
      },
    },
  };
  const tool = createDurableTool("projected_context", { version: "1" })
    .description("Project context through the public client")
    .parameters(z.object({}))
    .effects({
      read: {
        version: "1",
        input: contextSchema,
        output: contextSchema,
        inputProjections: {
          inputProjection: { type: "object", properties: { value: { type: "string" } } },
          outputProjection: { type: "object", properties: { value: { type: "number" } } },
        },
        outputProjections: {
          inputProjection: { type: "object", properties: { value: { type: "string" } } },
          outputProjection: { type: "object", properties: { value: { type: "number" } } },
        },
        retrySafety: { mode: "unsafe" },
      },
    })
    .elicits({
      choose: {
        response: contextSchema,
        responseProjections: {
          inputProjection: { type: "object", properties: { value: { type: "string" } } },
          outputProjection: { type: "object", properties: { value: { type: "number" } } },
        },
        context: contextSchema,
        contextProjections: {
          inputProjection: { type: "object", properties: { value: { type: "string" } } },
          outputProjection: { type: "object", properties: { value: { type: "number" } } },
        },
      },
    })
    .execute(function* (_, ctx) {
      const effect = yield* ctx.effect("read", { value: "2" });
      const answer = yield* ctx.elicit("choose", {
        message: "Choose",
        context: { value: String(effect.value) },
      });
      return answer.action === "accept" ? { selected: answer.content.value } : null;
    });
  const seen: unknown[] = [];
  const effectInputs: unknown[] = [];
  const plugin = makePlugin(tool)
    .onElicit({
      *choose(request) {
        seen.push(request.context);
        expect(request.context).toEqual({ value: 5 });
        return { action: "accept", content: { value: String(request.context.value) } };
      },
    })
    .build();
  const directory = await mkdtemp(join(tmpdir(), "projected-chat-"));
  try {
    await withTestScenario(
      {
        binding: "http",
        createApplication: (context) => {
          const app = createPrimitiveChatApp({
            database: join(directory, "chat.sqlite"),
            basePath: "/assistant/chat",
            program: { id: "projected-chat", version: "1", digest: "projected-chat-v1" },
            tools: [tool],
            effectMiddleware: [
              {
                *effect([request], next) {
                  expect(request.input).toEqual({ value: 3 });
                  const outcome = yield* next({ ...request, input: { value: 30 } });
                  expect(outcome).toEqual({ ok: true, value: { value: "30" } });
                  return { ok: true, value: { value: "3" } };
                },
              },
            ],
            effects: {
              *"projected_context.read"(input) {
                effectInputs.push(input);
                return { ok: true, value: { value: "30" } };
              },
            },
            model: {
              identity: "scripted",
              model: context.model.model,
              driver: createPiAiModelProvider().driver,
              streamOptions: context.model.streamOptions,
            },
            authorize: () => true,
          });
          return { handle: app.handler, close: app.close };
        },
      },
      function* (rig) {
        const client = yield* useClient(rig, { threadId: "projected", plugins: [plugin] });
        const sending = yield* spawn(() => call(() => client.sendMessage("Choose")));
        const first = yield* rig.model.request();
        yield* first.respond.toolCalls([{ id: "projected-call", name: tool.name, arguments: {} }]);
        const final = yield* rig.model.request();
        expect(outputs(final.body.input)).toEqual([
          { id: "projected-call", output: { selected: 6 } },
        ]);
        yield* final.respond.text("Completed");
        yield* sending;
        yield* waitForSnapshot(client, (state) => state.status === "ready");
        expect(client.getSnapshot().error).toBeNull();
        expect(seen).toEqual([{ value: 5 }]);
        expect(effectInputs).toEqual([{ value: 30 }]);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
