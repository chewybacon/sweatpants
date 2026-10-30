import { mkdtemp, rm, readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { createChatClient } from "@sweatpants/react-chat";
import { serve } from "@sweatpants/agent-host/node";
import { createLocalYoChatApplication } from "../../../apps/yo-chat/src/server/local-chat-application.ts";

it("pages local history beyond 32 turns and releases all SQLite handles on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yo-chat-history-"));
  let calls = 0;
  const app = createLocalYoChatApplication({
    database: join(directory, "chat.sqlite"),
    model: {
      identity: "history-script",
      model: {
        id: "script",
        name: "Script",
        api: "script",
        provider: "script",
        reasoning: false,
        input: ["text"],
        contextWindow: 100000,
        maxTokens: 100,
      },
      driver: {
        *sample() {
          throw new Error("Buffered sampling is forbidden");
        },
        *stream(request) {
          const content =
            request.context.messages.at(-1)?.role === "user"
              ? Array.from({ length: 5 }, (_, index) => ({
                  type: "tool-call" as const,
                  toolCall: {
                    id: `call-${calls++}`,
                    name: "calculator",
                    input: { expression: `${index}+1` },
                    thoughtSignature: null,
                  },
                }))
              : [{ type: "text" as const, text: "Completed calculation." }];
          const response = {
            message: { role: "assistant" as const, content },
            source: null,
            usage: null,
            stopReason: "stop",
            responseId: null,
            errorMessage: null,
          };
          return {
            *[Symbol.iterator]() {
              return {
                *next() {
                  return { done: true as const, value: response };
                },
              };
            },
          };
        },
      },
    },
  });
  const server = await serve(app, { port: 0 });
  const client = createChatClient({
    threadId: "history",
    transport: { http: { api: `${server.origin}/api/chat` } },
  });
  try {
    await client.initialized;
    for (let index = 0; index < 34; index++) {
      await client.sendMessage(`Public turn ${index}`);
      expect(client.getSnapshot().error).toBeNull();
    }
    await client.reconnect();
    expect(client.getSnapshot().history.hasOlder).toBe(true);
    await client.loadOlder();
    expect(client.getSnapshot().history.hasOlder).toBe(false);
    expect(JSON.stringify(client.getSnapshot().messages)).toContain("Public turn 0");
    expect(JSON.stringify(client.getSnapshot().messages)).toContain("Public turn 33");
    expect(calls).toBe(170);
  } finally {
    await client.close();
    await server.close();
    const handles = await Promise.all(
      (await readdir("/proc/self/fd")).map(async (fd) => {
        try {
          return await readlink(`/proc/self/fd/${fd}`);
        } catch {
          return "";
        }
      }),
    );
    expect(handles.filter((path) => path.startsWith(directory))).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("streams reasoning and text, retains interrupted presentation, and excludes it from subsequent inference", async () => {
  const { run, suspend } = await import("effection");
  const { waitForSnapshot } = await import("../../support/client.ts");
  const directory = await mkdtemp(join(tmpdir(), "yo-chat-partial-"));
  let samples = 0;
  let aborted = false;
  let subsequentInput = "";
  const options: Parameters<typeof createLocalYoChatApplication>[0] = {
    database: join(directory, "chat.sqlite"),
    model: {
      identity: "partial-script",
      model: {
        id: "script",
        name: "Script",
        api: "script",
        provider: "script",
        reasoning: true,
        input: ["text"],
        contextWindow: 10000,
        maxTokens: 100,
      },
      driver: {
        *sample() {
          throw new Error("Buffered sampling is forbidden");
        },
        *stream(request) {
          const first = samples++ === 0;
          let step = 0;
          const partial = {
            role: "assistant" as const,
            content: [
              {
                type: "reasoning" as const,
                text: "Provisional reasoning",
                format: null,
                signature: null,
                redacted: false,
              },
              { type: "text" as const, text: "Provisional answer" },
            ],
          };
          if (first) {
            request.options?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
          } else {
            subsequentInput = JSON.stringify(request.context.messages);
          }
          return {
            *[Symbol.iterator]() {
              return {
                *next() {
                  if (!first) {
                    return {
                      done: true as const,
                      value: {
                        message: {
                          role: "assistant" as const,
                          content: [{ type: "text" as const, text: "Recovered." }],
                        },
                        source: null,
                        usage: null,
                        stopReason: "stop",
                        responseId: null,
                        errorMessage: null,
                      },
                    };
                  }
                  if (step++ === 0) {
                    return {
                      done: false as const,
                      value: {
                        type: "reasoning-delta" as const,
                        contentIndex: 0,
                        delta: "Provisional reasoning",
                        partial,
                      },
                    };
                  }
                  yield* suspend();
                  throw new Error("unreachable");
                },
              };
            },
          };
        },
      },
    },
  };
  let server = await serve(createLocalYoChatApplication(options), { port: 0 });
  let client = createChatClient({
    threadId: "partial",
    transport: { http: { api: `${server.origin}/api/chat` } },
  });
  try {
    await client.initialized;
    const sending = client.sendMessage("Start");
    await run(() =>
      waitForSnapshot(client, (state) =>
        JSON.stringify(state.messages).includes("Provisional reasoning"),
      ),
    );
    expect(JSON.stringify(client.getSnapshot().messages)).toContain("Provisional answer");
    expect(client.getSnapshot().authority?.state).toBe("running");
    await client.stop();
    await sending;
    expect(aborted).toBe(true);
    await client.close();
    await server.close();
    server = await serve(createLocalYoChatApplication(options), { port: 0 });
    client = createChatClient({
      threadId: "partial",
      transport: { http: { api: `${server.origin}/api/chat` } },
    });
    await client.initialized;
    expect(JSON.stringify(client.getSnapshot().messages)).toContain("Provisional reasoning");
    expect(samples).toBe(1);
    await client.sendMessage("New turn");
    expect(subsequentInput).not.toContain("Provisional");
    expect(subsequentInput).toContain("Start");
    expect(client.getSnapshot().error).toBeNull();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
