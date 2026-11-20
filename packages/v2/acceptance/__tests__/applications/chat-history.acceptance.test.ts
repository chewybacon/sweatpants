import { deserialize, serialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery, type Accepted } from "@sweatpan.ts/durable";
import {
  defineChatProgram,
  createChatToolBinding,
  type ChatRecoveryFactory,
} from "@sweatpan.ts/chat-host";
import { defineTool } from "@sweatpan.ts/tools";
import { createMemoryJournalStore } from "@sweatpan.ts/storage-memory";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { createSqliteDatabaseRig } from "@sweatpan.ts/testing";
import type { ChatHistoryMessage, ChatLoopResult, ChatLoopSample } from "@sweatpan.ts/chat";
import type { ChatContent, ChatContentPart } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: compact sample boundaries restore exact multimodal history after SQLite reopen`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const confirm = defineEffect({
      key: "history/confirm",
      context: z.number(),
      response: z.boolean(),
    });
    const detail = "retained tool detail ".repeat(1024) + "🔬".slice(0, 1);
    const tool = defineTool("history/tool")
      .parameters(z.number())
      .elicits({ confirm })
      .execute(function* (round, context) {
        if (round === 3) {
          const answer = yield* context.elicit("confirm", round);
          if (!answer.ok || !answer.value) {
            throw new Error("Approval required");
          }
        }
        return { round, detail };
      });
    const initial: ChatHistoryMessage[] = [
      { role: "system", content: "Pinned instructions ".repeat(4096) },
      { role: "user", content: "Read the retained observations" + "🔬".slice(0, 1) },
    ];
    const image: readonly ChatContentPart[] = [
      {
        type: "image",
        source: { type: "data", value: "cG5n", mimeType: "image/png" },
        metadata: { frame: 1 },
      },
    ];
    function toolContent(value: unknown, signature: string | null): ChatContent {
      return [{ type: "text", text: JSON.stringify({ value, signature }) }, ...image];
    }
    let changedSignedZero = false;
    const signedZero: ChatHistoryMessage = {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "data", value: "cG5n", mimeType: "image/png" },
          metadata: { x: -0 },
        },
      ],
    };
    initial.push(signedZero);
    let changedInstructions = false;
    let changedTools = false;
    let changedFormatting = false;
    const program = defineChatProgram({
      id: "history/chat",
      history() {
        if (changedSignedZero) {
          return initial.map((message) =>
            message === signedZero
              ? {
                  ...signedZero,
                  content: [
                    {
                      type: "image",
                      source: { type: "data", value: "cG5n", mimeType: "image/png" },
                      metadata: { x: 0 },
                    },
                  ],
                }
              : message,
          );
        }
        return changedInstructions ? [{ role: "user", content: "changed" }] : initial;
      },
      toolResult(value, call) {
        return {
          content: toolContent(
            changedFormatting ? { changed: value } : value,
            call.thoughtSignature,
          ),
          isError: false,
        };
      },
      result(value) {
        return value;
      },
    });
    expect(program.id).toBe("history/chat/recorded-chat/v2");
    let samples = 0;
    const expected = structuredClone(initial);
    const definitions = [
      { name: "read", description: "Read an observation", parameters: { type: "number" } },
    ];
    function open() {
      return createSqliteJournalStore<
        ChatLoopResult,
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({
        id: "history",
        program: program.id,
        equals: isDeepStrictEqual,
        connection: createNodeSqliteConnection(database.database),
        serialization: {
          *resolve() {
            return v8Serializer;
          },
        },
      }).open();
    }
    async function command(mode: "start" | "answer" | "continue" | "replay") {
      const owner = runtime.start(function* () {
        const journal = open();
        const recovery: ChatRecoveryFactory<Y> = (options) =>
          createRecovery(runtime.composition, options);
        const binding = createChatToolBinding(runtime, tool, {
          definition: {
            ...definitions[0]!,
            description: changedTools ? "Changed catalog" : definitions[0]!.description,
          },
          recovery,
          matches: isDeepStrictEqual,
        });
        const chat = program.bind(runtime, {
          journal,
          tools: [binding],
          recovery,
          matches: isDeepStrictEqual,
          sampling: {
            *sample(request) {
              if (mode === "replay") {
                throw new Error("Replay dispatched a model request");
              }
              expect(request.round).toBe(samples);
              expect(request.history).toEqual(expected);
              expect(request.tools).toEqual(definitions);
              // A driver cannot mutate the retained cache through its request.
              const round = samples++;
              const sample: ChatLoopSample = {
                model: { id: "fixture", provider: "fixture", api: "scripted" },
                response: {
                  message: {
                    role: "assistant",
                    content:
                      round < 12
                        ? [
                            {
                              type: "tool-call",
                              toolCall: {
                                id: "call-" + round,
                                name: "read",
                                input: round,
                                thoughtSignature: "retained-signature-" + round,
                              },
                            },
                          ]
                        : [{ type: "text", text: "Complete" }],
                  },
                  source: null,
                  usage: null,
                  stopReason: round < 12 ? "toolUse" : "stop",
                  responseId: null,
                  errorMessage: null,
                },
              };
              expected.push({ ...structuredClone(sample.response.message), model: sample.model });
              if (round < 12) {
                expected.push({
                  role: "tool",
                  toolCallId: "call-" + round,
                  name: "read",
                  content: toolContent({ round, detail }, "retained-signature-" + round),
                  isError: false,
                });
              }
              (request.history as ChatHistoryMessage[]).splice(0);
              return { ok: true, value: sample };
            },
          },
        });
        if (mode === "start") {
          yield* journal.admit(program.id, {});
        }
        if (mode === "answer") {
          const interactions = yield* chat.interactions();
          const next = yield* interactions.next();
          if (next.done) {
            throw new Error("Missing retained approval");
          }
          yield* chat.answer(
            { execution: next.value.execution, grant: next.value.grant },
            { ok: true, value: true },
          );
        }
        return yield* chat.run();
      });
      onTestFinished(() => owner.cancel());
      return await owner.result;
    }
    expect((await command("start")).state).toBe("child");
    expect(samples).toBe(4);
    database.reopen();
    expect((await command("replay")).state).toBe("child");
    expect(samples).toBe(4);
    changedSignedZero = true;
    await expect(command("answer")).rejects.toThrow("Replay request mismatch");
    changedSignedZero = false;
    changedInstructions = true;
    await expect(command("continue")).rejects.toThrow("Replay request mismatch");
    changedInstructions = false;
    changedTools = true;
    await expect(command("replay")).rejects.toThrow("Replay request mismatch");
    changedTools = false;
    changedFormatting = true;
    await expect(command("continue")).rejects.toThrow("Replay request mismatch");
    changedFormatting = false;
    expect(samples).toBe(4);
    const complete = await command("continue");
    expect(complete.state).toBe("completed");
    const snapshot = await runtime.start(function* () {
      return yield* open().read();
    }).result;
    expect(snapshot.status).toBe("completed");
    if (snapshot.status === "completed") {
      expect(snapshot.value.history).toEqual(expected);
    }
    const rows = database.database
      .prepare(
        "SELECT payload FROM sweatpants_history WHERE tree = ? AND execution = ? ORDER BY sequence",
      )
      .all("history", "history");
    const entries = rows.map(
      (row) =>
        deserialize(row.payload as Uint8Array) as Accepted<CapabilityRequest, unknown, string>,
    );
    const boundaries = entries.filter((entry) => entry.request.effect === program.id + "/sample");
    expect(boundaries).toHaveLength(13);
    for (const entry of boundaries) {
      expect(Object.keys(entry.request.input as object).sort()).toEqual([
        "historyHash",
        "historyLength",
        "round",
      ]);
      expect(serialize(entry.request).byteLength).toBeLessThan(256);
    }
    expect(
      boundaries.reduce((size, entry) => size + serialize(entry.request).byteLength, 0),
    ).toBeLessThan(4096);
    database.reopen();
    expect((await command("replay")).state).toBe("completed");
    expect(samples).toBe(13);
  });

  it(`${runtime.name}: failed preparation claims no delivery and a failed history projection can be retried on the same binding`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    let failRead = true,
      failProjection = false,
      deliveries = 0;
    const tool = defineTool("history/retry-tool")
      .parameters(z.null())
      .execute(function* () {
        return "observation";
      });
    const program = defineChatProgram({
      id: "history/preparation",
      history() {
        return [{ role: "user", content: "Read once" }];
      },
      toolResult(value) {
        if (failProjection) {
          failProjection = false;
          throw Error("Temporary projection failure");
        }
        return { content: String(value), isError: false };
      },
      result({ response, rounds }) {
        return { response, rounds };
      },
    });
    const journal = createSqliteJournalStore<
      { response: ChatLoopSample["response"]; rounds: number },
      CapabilityRequest,
      unknown,
      string,
      unknown,
      Y
    >({
      id: "preparation",
      program: program.id,
      equals: isDeepStrictEqual,
      connection: createNodeSqliteConnection(database.database),
      serialization: {
        *resolve() {
          return v8Serializer;
        },
      },
    }).open();
    const readable = {
      ...journal,
      *read() {
        const snapshot = yield* journal.read();
        return {
          ...snapshot,
          history: {
            ...snapshot.history,
            *read(position: number, limit: number) {
              if (failRead) {
                failRead = false;
                throw Error("Temporary journal read failure");
              }
              return yield* snapshot.history.read(position, limit);
            },
          },
        };
      },
    };
    const chat = program.bind(runtime, {
      journal: readable,
      tools: [
        createChatToolBinding(runtime, tool, {
          definition: { name: "read", description: "Read", parameters: { type: "null" } },
          matches: isDeepStrictEqual,
          recovery: (options) => createRecovery(runtime.composition, options),
        }),
      ],
      matches: isDeepStrictEqual,
      recovery: (options) => createRecovery(runtime.composition, options),
      sampling: {
        *sample() {
          const round = deliveries++;
          return {
            ok: true,
            value: {
              model: { id: "fixture", provider: "fixture", api: "scripted" },
              response: {
                message: {
                  role: "assistant",
                  content:
                    round === 0
                      ? [
                          {
                            type: "tool-call",
                            toolCall: {
                              id: "read-1",
                              name: "read",
                              input: null,
                              thoughtSignature: null,
                            },
                          },
                        ]
                      : [{ type: "text", text: "Done" }],
                },
                source: null,
                usage: null,
                stopReason: round === 0 ? "toolUse" : "stop",
                responseId: null,
                errorMessage: null,
              },
            } satisfies ChatLoopSample,
          };
        },
      },
    });
    await runtime.start(function* () {
      yield* journal.admit(program.id, {});
    }).result;
    await expect(runtime.start(() => chat.run()).result).rejects.toThrow(
      "Temporary journal read failure",
    );
    expect(deliveries).toBe(0);
    expect((await runtime.start(() => chat.run()).result).state).toBe("completed");
    expect(deliveries).toBe(2);
    // A new binding must reconstruct a page containing both the sample and tool
    // batch. Fail after applying the sample, then retry that exact cache.
    const reopened = program.bind(runtime, {
      journal,
      tools: [
        createChatToolBinding(runtime, tool, {
          definition: { name: "read", description: "Read", parameters: { type: "null" } },
          matches: isDeepStrictEqual,
          recovery: (options) => createRecovery(runtime.composition, options),
        }),
      ],
      matches: isDeepStrictEqual,
      recovery: (options) => createRecovery(runtime.composition, options),
      sampling: {
        *sample() {
          throw Error("History dispatched sampling");
        },
      },
    });
    failProjection = true;
    await expect(runtime.start(() => reopened.history()).result).rejects.toThrow(
      "Temporary projection failure",
    );
    const history = await runtime.start(() => reopened.history()).result;
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(deliveries).toBe(2);
  });

  it(`${runtime.name}: inherited memory history restores through public bindings without model delivery`, async () => {
    const inherited: readonly ChatHistoryMessage[] = [
      { role: "system", content: "An immutable inherited prefix" },
    ];
    const program = defineChatProgram({
      id: "history/inherited",
      history(input) {
        return [{ role: "user", content: z.object({ prompt: z.string() }).parse(input).prompt }];
      },
      toolResult() {
        return { content: "unused", isError: false };
      },
      result() {
        return "done";
      },
    });
    const store = createMemoryJournalStore<string, CapabilityRequest, unknown, string>({
      program: program.id,
      equals: isDeepStrictEqual,
    });
    let fail = true,
      deliveries = 0;
    function bind() {
      return program.bind(runtime, {
        journal: store.open(),
        tools: [],
        matches: isDeepStrictEqual,
        recovery: (options) => createRecovery(runtime.composition, options),
        historySource: {
          *read() {
            if (fail) {
              fail = false;
              throw Error("Source temporarily unavailable");
            }
            return inherited;
          },
        },
        sampling: {
          *sample(request) {
            expect(request.history).toEqual([...inherited, { role: "user", content: "Continue" }]);
            deliveries++;
            return {
              ok: true,
              value: {
                model: { id: "fixture", provider: "fixture", api: "scripted" },
                response: {
                  message: { role: "assistant", content: [{ type: "text", text: "Complete" }] },
                  source: null,
                  usage: null,
                  stopReason: "stop",
                  responseId: null,
                  errorMessage: null,
                },
              } satisfies ChatLoopSample,
            };
          },
        },
      });
    }
    await runtime.start(function* () {
      yield* store.open().admit(program.id, { prompt: "Continue" });
    }).result;
    const chat = bind();
    await expect(runtime.start(() => chat.run()).result).rejects.toThrow(
      "Source temporarily unavailable",
    );
    expect(deliveries).toBe(0);
    expect(await runtime.start(() => chat.run()).result).toMatchObject({
      state: "completed",
      value: "done",
    });
    const restored = bind();
    const first = await runtime.start(() => restored.history()).result;
    expect(first.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    (first as ChatHistoryMessage[]).splice(0);
    expect((await runtime.start(() => restored.history()).result).length).toBe(3);
    expect(await runtime.start(() => restored.run()).result).toMatchObject({
      state: "completed",
      value: "done",
    });
    expect(deliveries).toBe(1);
  });

  it(`${runtime.name}: reopening an uncertain compact sample preserves its occupied delivery`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const program = defineChatProgram({
      id: "history/uncertain",
      history() {
        return [{ role: "user", content: "An exact retained prompt" }];
      },
      toolResult() {
        return { content: "unused", isError: false };
      },
      result(value) {
        return value;
      },
    });
    let deliveries = 0;
    function open() {
      return createSqliteJournalStore<
        ChatLoopResult,
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({
        id: "uncertain",
        program: program.id,
        equals: isDeepStrictEqual,
        connection: createNodeSqliteConnection(database.database),
        serialization: {
          *resolve() {
            return v8Serializer;
          },
        },
      }).open();
    }
    async function command(start = false) {
      const task = runtime.start(function* () {
        const journal = open();
        const chat = program.bind(runtime, {
          journal,
          tools: [],
          matches: isDeepStrictEqual,
          recovery: (options) => createRecovery(runtime.composition, options),
          sampling: {
            *sample() {
              deliveries++;
              throw new Error("Provider delivery uncertain");
            },
          },
        });
        if (start) {
          yield* journal.admit(program.id, {});
        }
        return yield* chat.run();
      });
      onTestFinished(() => task.cancel());
      return await task.result;
    }
    await expect(command(true)).rejects.toThrow("Provider delivery uncertain");
    database.reopen();
    const snapshot = await runtime.start(function* () {
      return yield* open().read();
    }).result;
    expect(snapshot.history.end.position).toBe(0);
    if (snapshot.status !== "running" || !snapshot.pending) {
      throw new Error("Uncertain sample lost its pending request");
    }
    expect(serialize(snapshot.pending.request).byteLength).toBeLessThan(256);
    expect(await command()).toMatchObject({ state: "occupied" });
    expect(deliveries).toBe(1);
  });
});
