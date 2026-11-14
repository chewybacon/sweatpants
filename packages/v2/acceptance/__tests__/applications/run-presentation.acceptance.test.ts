import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery } from "@sweatpan.ts/durable";
import {
  createChatPresentation,
  createChatToolBinding,
  defineChatProgram,
  type ChatPresentationEvent,
  type ChatRecoveryFactory,
} from "@sweatpan.ts/chat-host";
import { createExecutionPresentation } from "@sweatpan.ts/hosting";
import { defineTool } from "@sweatpan.ts/tools";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatLoopResult } from "@sweatpan.ts/chat";
import type { ModelResponse } from "@sweatpan.ts/providers";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: one scoped presentation covers chat children, answers and retained replay`, async () => {
    const read = defineEffect({
      key: "presentation/read",
      context: z.string(),
      response: z.string(),
    });
    const confirm = defineEffect({
      key: "presentation/confirm",
      context: z.string(),
      response: z.boolean(),
    });
    let reads = 0,
      samples = 0;
    const readTool = defineTool("presentation/read-tool")
      .parameters(z.string())
      .capabilities({ read })
      .execute(function* (input, context) {
        return yield* context.capabilities.read(input);
      });
    const askTool = defineTool("presentation/ask-tool")
      .parameters(z.string())
      .elicits({ confirm })
      .execute(function* (input, context) {
        return yield* context.elicit("confirm", input);
      });
    const program = defineChatProgram({
      id: "presentation/chat",
      history() {
        return [{ role: "user", content: "Read and ask" }];
      },
      toolResult(value) {
        return { content: JSON.stringify(value), isError: false };
      },
      result(value) {
        return value;
      },
    });
    const store = createSqliteJournalRig<
      ChatLoopResult,
      CapabilityRequest,
      unknown,
      string,
      unknown,
      Y
    >({ program: program.id, equals: isDeepStrictEqual });
    onTestFinished(() => store.close());
    async function command(mode: "start" | "answer" | "replay", observe = true) {
      const events: ChatPresentationEvent[] = [];
      const owner = runtime.start(function* () {
        const journal = store.open();
        if (observe) {
          const chat = createChatPresentation({
            program: program.id,
            execution: journal.id,
            emit: (value) => events.push(value),
          });
          const presentation = createExecutionPresentation(runtime.composition, chat.present);
          yield* presentation.restore(journal);
          yield* presentation.install();
        }
        const recovery: ChatRecoveryFactory<Y> = (options) =>
          createRecovery(runtime.composition, options);
        const bindings = [
          createChatToolBinding(runtime, readTool, {
            definition: {
              name: "read",
              description: "read",
              parameters: { type: "string" },
            },
            matches: isDeepStrictEqual,
            recovery,
            *configure({ effects }) {
              yield* effects.install(read, function* () {
                reads++;
                return { ok: true, value: "original" };
              });
            },
          }),
          createChatToolBinding(runtime, askTool, {
            definition: { name: "ask", description: "ask", parameters: { type: "string" } },
            matches: isDeepStrictEqual,
            recovery,
          }),
        ];
        const chat = program.bind(runtime, {
          journal,
          tools: bindings,
          recovery,
          matches: isDeepStrictEqual,
          sampling: {
            *sample(request) {
              if (mode === "replay") {
                throw new Error("Replay sampled");
              }
              samples++;
              const content: ModelResponse["message"]["content"] =
                request.round === 0
                  ? [
                      {
                        type: "tool-call",
                        toolCall: {
                          id: "repeat",
                          name: "read",
                          input: "guide",
                          thoughtSignature: "private-signature",
                        },
                      },
                      {
                        type: "tool-call",
                        toolCall: {
                          id: "ask",
                          name: "ask",
                          input: "Continue?",
                          thoughtSignature: null,
                        },
                      },
                    ]
                  : request.round === 1
                    ? [
                        {
                          type: "tool-call",
                          toolCall: {
                            id: "second-read",
                            name: "read",
                            input: "again",
                            thoughtSignature: null,
                          },
                        },
                      ]
                    : [{ type: "text", text: "Done" }];
              return {
                ok: true,
                value: {
                  model: { id: "fixture", provider: "fixture", api: "scripted" },
                  response: {
                    message: { role: "assistant", content },
                    source: {
                      api: "scripted",
                      provider: "fixture",
                      model: "fixture",
                      responseModel: "fixture",
                    },
                    usage: null,
                    stopReason: request.round < 2 ? "toolUse" : "stop",
                    responseId: null,
                    errorMessage: null,
                  },
                },
              };
            },
          },
        });
        if (mode === "start") {
          yield* journal.admit(program.id, {});
        }
        if (mode === "answer") {
          const stream = yield* chat.interactions();
          const question = yield* stream.next();
          if (question.done) {
            throw new Error("Missing question");
          }
          yield* chat.answer(
            { execution: question.value.execution, grant: question.value.grant },
            { ok: true, value: true },
          );
        }
        return yield* chat.run();
      });
      onTestFinished(() => owner.cancel());
      const result = await owner.result;
      return { result, events };
    }
    const waiting = await command("start");
    expect(waiting.events.filter((event) => event.kind === "result")).toHaveLength(1);
    expect(waiting.events.some((event) => event.kind === "tool" && event.state === "waiting")).toBe(
      true,
    );
    expect(
      waiting.events.some(
        (event) =>
          event.kind === "operation" && event.state === "accepted" && event.effect === read.id,
      ),
    ).toBe(true);
    store.reopen();
    const parked = await command("replay");
    expect(parked.events.filter((event) => event.kind === "call").map((event) => event.id)).toEqual(
      waiting.events.filter((event) => event.kind === "call").map((event) => event.id),
    );
    expect([reads, samples]).toEqual([1, 1]);
    const complete = await command("answer");
    expect(complete.result.state).toBe("completed");
    const calls = complete.events.filter((event) => event.kind === "call");
    expect(new Set(calls.map((event) => event.id)).size).toBe(3);
    expect(complete.events.filter((event) => event.kind === "result")).toHaveLength(3);
    expect(JSON.stringify(complete.events)).not.toContain("private-signature");
    expect(
      complete.events.some(
        (event) =>
          event.kind === "operation" && event.effect === confirm.id && event.state === "accepted",
      ),
    ).toBe(true);
    store.reopen();
    const replay = await command("replay");
    expect(
      replay.events.filter((event) => event.kind === "result").map((event) => event.id),
    ).toEqual(complete.events.filter((event) => event.kind === "result").map((event) => event.id));
    expect(replay.events.every((event) => event.replay)).toBe(true);
    expect([reads, samples]).toEqual([2, 3]);
    expect((await command("replay", false)).events).toEqual([]);
  });
});
