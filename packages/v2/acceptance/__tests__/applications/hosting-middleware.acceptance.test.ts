import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery } from "@sweatpan.ts/durable";
import {
  createChatToolBinding,
  defineChatProgram,
  type ChatRecoveryFactory,
} from "@sweatpan.ts/chat-host";
import { installHostingMiddleware } from "@sweatpan.ts/hosting";
import { defineTool } from "@sweatpan.ts/tools";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { ChatLoopResult, ChatLoopSample } from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: scoped middleware observes root and tool child hosts without changing delivery`, async () => {
    const read = defineEffect({ key: "scoped/read", context: z.string(), response: z.string() });
    const tool = defineTool("scoped/read-tool")
      .parameters(z.string())
      .capabilities({ read })
      .execute(function* (input, context) {
        return yield* context.capabilities.read(input);
      });
    const program = defineChatProgram({
      id: "scoped/chat",
      history() {
        return [{ role: "user", content: "Read" }];
      },
      toolResult(value) {
        return { content: String(value), isError: false };
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
    const observed: string[] = [];
    let reads = 0;
    const result = await runtime.start(function* () {
      yield* installHostingMiddleware(runtime.composition, {
        *install(host, journal) {
          const execution = "id" in journal ? String(journal.id) : "unknown";
          yield* host.around({
            *child(args, next) {
              const child = yield* next(...args);
              observed.push(`${execution}:child:${child ? "routed" : "none"}`);
              return child;
            },
            *handle([request], next) {
              const effect = (request as CapabilityRequest).effect;
              observed.push(`${execution}:handle:${effect}`);
              return yield* next(request);
            },
          });
          yield* host.attempts.around({
            *settle(args, next) {
              const accepted = yield* next(...args);
              observed.push(`${execution}:settled`);
              return accepted;
            },
          });
        },
      });
      const journal = store.open();
      const recovery: ChatRecoveryFactory<Y> = (options) =>
        createRecovery(runtime.composition, options);
      const chat = program.bind(runtime, {
        journal,
        recovery,
        matches: isDeepStrictEqual,
        tools: [
          createChatToolBinding(runtime, tool, {
            definition: { name: "read", description: "Read", parameters: { type: "string" } },
            recovery,
            matches: isDeepStrictEqual,
            *configure({ effects }) {
              yield* effects.install(read, function* () {
                reads++;
                return { ok: true, value: "observed" };
              });
            },
          }),
        ],
        sampling: {
          *sample(request) {
            const content =
              request.round === 0
                ? [
                    {
                      type: "tool-call" as const,
                      toolCall: {
                        id: "read",
                        name: "read",
                        input: "guide",
                        thoughtSignature: null,
                      },
                    },
                  ]
                : [{ type: "text" as const, text: "Done" }];
            return {
              ok: true,
              value: {
                model: { id: "fixture", provider: "fixture", api: "scripted" },
                response: {
                  message: { role: "assistant", content },
                  source: null,
                  usage: null,
                  stopReason: request.round === 0 ? "toolUse" : "stop",
                  responseId: null,
                  errorMessage: null,
                },
              } satisfies ChatLoopSample,
            };
          },
        },
      });
      yield* journal.admit(program.id, {});
      return yield* chat.run();
    }).result;
    expect(result.state).toBe("completed");
    expect(reads).toBe(1);
    expect(observed.some((entry) => entry.endsWith(`:handle:${read.id}`))).toBe(true);
    expect(observed.filter((entry) => entry.endsWith(":child:routed"))).toHaveLength(1);
    expect(observed.filter((entry) => entry.endsWith(":settled")).length).toBeGreaterThanOrEqual(3);
  });
});
