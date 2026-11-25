import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { defineAgent } from "@sweatpan.ts/agent";
import { prepareChatInference, type ChatSampling } from "@sweatpan.ts/chat";
import { defineChatProgram } from "@sweatpan.ts/chat-host";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { installHostingMiddleware } from "@sweatpan.ts/hosting";
import { createPiAiProvider, describePiAiModel } from "@sweatpan.ts/providers-pi-ai";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createLatch, createSqliteJournalRig } from "@sweatpan.ts/testing";
import { defineTool } from "@sweatpan.ts/tools";
import { forEachRuntime } from "../runtime/assembly.ts";

const search = defineEffect({
  key: "private.search",
  context: z.object({ pattern: z.string() }),
  response: z.string(),
});
const rg = defineTool("rg")
  .description("Search this workspace")
  .parameters(z.object({ term: z.string() }).transform(({ term }) => ({ pattern: term })))
  .capabilities({ search })
  .execute(function* (input, ctx) {
    return yield* ctx.capabilities.search(input);
  });
const agent = defineAgent({ tools: [rg] });
const program = defineChatProgram({
  id: "agent/search/1",
  history() {
    return [{ role: "user", content: "Search" }];
  },
  toolResult(value) {
    return { content: JSON.stringify(value), isError: false };
  },
  rejectToolCall: (rejection) => rejection.reason,
  result: () => "finished",
});

type Call = { name: string; args: unknown };
// Script only the remote peer. pi-ai and its OpenAI client still serialize and parse every turn.
async function serve<Y>(runtime: Runtime<Y>, replies: (Call | null)[]) {
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    bodies.push(JSON.parse(body));
    const call = replies.shift();
    if (call === undefined) {
      res.writeHead(400);
      res.end("unexpected model turn");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_search",
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }
      : { role: "assistant", content: "done" };
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(replies).toEqual([]);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback server");
  }
  const model = {
    id: "fixture",
    name: "fixture",
    api: "openai-completions" as const,
    provider: "test",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    input: ["text" as const],
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const info = describePiAiModel(model);
  const provider = createPiAiProvider(runtime, {
    model,
    apiKey: "fixture",
    stream: (selected, context, options) =>
      streamSimple({ ...selected, api: "openai-completions" }, context, options),
  });
  const sampling: ChatSampling<Y> = {
    *sample(request) {
      const inference = prepareChatInference({
        model: info,
        history: request.history,
        tools: request.tools,
      });
      const stream = yield* provider.stream(inference.request);
      while (true) {
        const item = yield* stream.next();
        if (item.done) {
          return { ok: true, value: { model: info, response: item.value } };
        }
      }
    },
  };
  return { sampling, bodies };
}

it("rejects ambiguous inventories and non-projectable parameters at definition", () => {
  expect(() => defineAgent({ tools: [rg, rg] })).toThrow(/duplicate/i);
  const invalid = defineTool("invalid")
    .parameters(z.object({ value: z.symbol() }))
    .execute(function* () {
      return true;
    });
  expect(() => defineAgent({ tools: [invalid] })).toThrow(/symbol/i);
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function store() {
    const rig = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: program.id,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => rig.close());
    return rig;
  }
  it(`${runtime.name}: replay accepted search before chat consumes it`, async () => {
    const peer = await serve(runtime, [{ name: "rg", args: { term: "oak" } }, null]);
    const database = store();
    let journal = database.open();
    let workspace = "first";
    const searched: string[] = [];
    function bind() {
      return agent.bind(runtime, program, {
        journal,
        sampling: peer.sampling,
        *installEffects(effects) {
          yield* effects.install(search, function* ({ pattern }) {
            searched.push(pattern);
            return { ok: true, value: workspace };
          });
        },
      });
    }
    await expect(
      runtime.start(function* () {
        yield* installHostingMiddleware(runtime.composition, {
          *install(host) {
            yield* host.attempts.around({
              *settle(args, next) {
                const accepted = yield* next(...args);
                if ((accepted.entry.request as CapabilityRequest).effect === search.id) {
                  throw new Error("search committed; connection lost");
                }
                return accepted;
              },
            });
          },
        });
        yield* journal.admit(program.id, {});
        return yield* bind().run();
      }).result,
    ).rejects.toThrow(/search committed/);
    expect(peer.bodies).toHaveLength(1);
    workspace = "changed";
    journal = database.reopen();
    expect(await runtime.start(() => bind().run()).result).toMatchObject({ state: "completed" });
    expect(searched).toEqual(["oak"]);
    expect(peer.bodies[0]).toMatchObject({
      tools: [
        {
          function: {
            name: "rg",
            description: "Search this workspace",
            parameters: { required: ["term"], properties: { term: { type: "string" } } },
          },
        },
      ],
    });
    expect(peer.bodies[1]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: JSON.stringify({ ok: true, value: "first" }),
        }),
      ]),
    });
  });
  it(`${runtime.name}: cancelling one workspace search leaves the other run live`, async () => {
    const query = { name: "rg", args: { term: "oak" } };
    async function startWorkspace(label: string, finish: boolean) {
      const peer = await serve(runtime, finish ? [query, null] : [query]);
      const root = await mkdtemp(join(tmpdir(), "agent-workspace-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      await writeFile(join(root, "index.txt"), `${label}:oak`);
      const journal = store().open();
      const entered = createLatch<void>();
      const release = createLatch<void>();
      const closed = createLatch<void>();
      const task = runtime.start(function* () {
        yield* journal.admit(program.id, {});
        return yield* agent
          .bind(runtime, program, {
            journal,
            sampling: peer.sampling,
            *installEffects(effects) {
              yield* effects.install(search, function* ({ pattern }) {
                try {
                  const text = yield* runtime.fromPromise(() =>
                    readFile(join(root, "index.txt"), "utf8"),
                  );
                  entered.resolve();
                  yield* runtime.fromPromise((signal) =>
                    Promise.race([release.promise, once(signal, "abort").then(() => undefined)]),
                  );
                  return { ok: true, value: text.includes(pattern) ? text : "" };
                } finally {
                  closed.resolve();
                }
              });
            },
          })
          .run();
      });
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      await Promise.race([
        entered.promise,
        task.result.then(() => {
          throw new Error("Search did not enter handler");
        }),
      ]);
      return { peer, task, closed, release };
    }
    const first = await startWorkspace("first", false);
    const second = await startWorkspace("second", true);
    await first.task.cancel();
    await first.closed.promise;
    second.release.resolve();
    expect(await second.task.result).toMatchObject({ state: "completed" });
    await second.closed.promise;
    expect(JSON.stringify(second.peer.bodies[1])).toContain("second:oak");
    expect(first.peer.bodies).toHaveLength(1);
  });

  for (const kind of ["empty", "private", "invalid", "missing", "isolated"] as const) {
    it(`${runtime.name}: ${kind} search assembly`, async () => {
      const call = {
        name: kind === "private" ? search.id : "rg",
        args: kind === "invalid" ? { pattern: "oak" } : { term: "oak" },
      };
      const peer = await serve(
        runtime,
        kind === "empty" ? [null] : kind === "missing" ? [call] : [call, null],
      );
      const selected = kind === "empty" ? defineAgent({ tools: [] }) : agent;
      const journal = store().open();
      const hits: string[] = [];
      const execution = runtime.start(function* () {
        yield* journal.admit(program.id, {});
        return yield* selected
          .bind(runtime, program, {
            journal,
            sampling: peer.sampling,
            *installEffects(effects) {
              if (kind !== "missing") {
                yield* effects.install(search, function* ({ pattern }) {
                  hits.push(pattern);
                  return { ok: true, value: "second workspace" };
                });
              }
            },
          })
          .run();
      });
      if (kind === "missing") {
        await expect(execution.result).rejects.toThrow(/handler is not installed/);
      } else {
        expect(await execution.result).toMatchObject({ state: "completed" });
      }
      if (kind === "empty") {
        expect(peer.bodies[0]).not.toHaveProperty("tools.0");
      }
      if (kind === "private" || kind === "invalid" || kind === "isolated") {
        expect(JSON.stringify(peer.bodies[1])).toContain(
          kind === "private"
            ? "unknown-tool"
            : kind === "invalid"
              ? "invalid-input"
              : "second workspace",
        );
      }
      expect(hits).toEqual(kind === "isolated" ? ["oak"] : []);
    });
  }
});
