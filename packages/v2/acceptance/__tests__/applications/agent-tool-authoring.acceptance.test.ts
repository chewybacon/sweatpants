import { DatabaseSync } from "node:sqlite";
import { serialize, deserialize } from "node:v8";
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
  it(`${runtime.name}: reopen a private child review and decline the original claim`, async () => {
    const manualReview = defineEffect({
      key: "manualReview",
      context: z.string(),
      response: z.enum(["approved", "declined"]),
    });
    const claim = z.object({ id: z.string() });
    const reviewClaim = defineTool("reviewClaim")
      .parameters(claim.transform(({ id }) => ({ pattern: id.toUpperCase() })))
      .capabilities({ predict: search })
      .elicits({ manualReview })
      .execute(function* (input, ctx) {
        const risk = yield* ctx.capabilities.predict(input);
        if (!risk.ok) {
          throw new Error("Prediction failed");
        }
        const answer = yield* ctx.elicit("manualReview", risk.value);
        if (!answer.ok) {
          throw new Error("Review failed");
        }
        return answer.value;
      });
    const received: unknown[] = [];
    const processClaim = defineTool("processClaim")
      .parameters(claim)
      .capabilities({ review: reviewClaim })
      .execute(function* (input, ctx) {
        const decision = yield* ctx.capabilities.review(input);
        received.push(decision);
        if (!decision.ok) {
          throw new Error("Child failed");
        }
        return { id: input.id, decision: decision.value };
      });
    const claims = defineAgent({ tools: [processClaim] });
    const peer = await serve(runtime, [{ name: "processClaim", args: { id: "oak" } }, null]);
    const database = store();
    let journal = database.open();
    const predictions: string[] = [];
    const bind = () =>
      claims.bind(runtime, program, {
        journal,
        sampling: peer.sampling,
        *installEffects(effects) {
          yield* effects.install(search, function* ({ pattern }) {
            predictions.push(pattern);
            return { ok: true, value: "high" };
          });
        },
      });
    let chat = bind();
    function question() {
      return runtime.start(function* () {
        const stream = yield* chat.interactions();
        const item = yield* stream.next();
        if (item.done) {
          throw new Error("Missing review");
        }
        return item.value;
      }).result;
    }
    await runtime.start(function* () {
      yield* journal.admit(program.id, {});
      return yield* chat.run();
    }).result;
    const first = await question();
    expect(first.program).toBe(reviewClaim.id);
    expect(peer.bodies[0]).toMatchObject({ tools: [{ function: { name: "processClaim" } }] });
    // Exercise recovery from inconsistent storage, not a mocked read failure.
    const parentLink = first.parent!;
    const sql = new DatabaseSync(database.path);
    try {
      const keys = [database.id, parentLink.execution, parentLink.requestId];
      const row = sql
        .prepare(
          "SELECT payload FROM sweatpants_requests WHERE tree=? AND execution=? AND request=?",
        )
        .get(...keys)!;
      const original = row.payload as Uint8Array;
      const boundary = deserialize(original);
      expect(boundary.children[0].childId).toBe(first.execution);
      const update = sql.prepare(
        "UPDATE sweatpants_requests SET payload=? WHERE tree=? AND execution=? AND request=?",
      );
      for (const corrupt of [{ program: "wrong" }, { childId: parentLink.execution }]) {
        update.run(
          serialize({ ...boundary, children: [{ ...boundary.children[0], ...corrupt }] }),
          ...keys,
        );
        journal = database.reopen();
        await expect(runtime.start(() => bind().run()).result).rejects.toThrow(/child|ownership/i);
        update.run(original, ...keys);
      }
    } finally {
      sql.close();
    }
    journal = database.reopen();
    chat = bind();
    const target = await question();
    expect(target.execution).toBe(first.execution);
    expect(target.grant).toEqual(first.grant);
    const withoutGrant = defineTool(processClaim.id)
      .parameters(claim)
      .execute(function* () {
        throw new Error("Revoked parent ran");
      });
    const revoked = defineAgent({ tools: [withoutGrant] }).bind(runtime, program, {
      journal,
      sampling: peer.sampling,
    });
    await expect(runtime.start(() => revoked.run()).result).rejects.toThrow(/not granted/);
    await expect(
      runtime.start(() =>
        chat.answer({ ...target, execution: journal.id }, { ok: true, value: "approved" }),
      ).result,
    ).rejects.toThrow();
    await expect(
      runtime.start(() => chat.answer(target, { ok: true, value: false })).result,
    ).rejects.toThrow();
    // The same program and elicit in another root do not identify this wait.
    const otherJournal = store().open();
    const otherPeer = await serve(runtime, [{ name: "processClaim", args: { id: "elm" } }, null]);
    const other = claims.bind(runtime, program, {
      journal: otherJournal,
      sampling: otherPeer.sampling,
      *installEffects(effects) {
        yield* effects.install(search, function* () {
          return { ok: true, value: "another high risk" };
        });
      },
    });
    const second = await runtime.start(function* () {
      yield* otherJournal.admit(program.id, {});
      yield* other.run();
      const stream = yield* other.interactions();
      const item = yield* stream.next();
      if (item.done) {
        throw new Error("Missing second review");
      }
      return item.value;
    }).result;
    await expect(
      runtime.start(() => chat.answer(second, { ok: true, value: "approved" })).result,
    ).rejects.toThrow();
    await expect(
      runtime.start(() =>
        chat.answer({ ...target, grant: second.grant }, { ok: true, value: "approved" }),
      ).result,
    ).rejects.toThrow();
    await runtime.start(() => chat.answer(target, { ok: true, value: "declined" })).result;
    expect(received).toEqual([]);
    expect(await runtime.start(() => chat.run()).result).toMatchObject({ state: "completed" });
    expect(predictions).toEqual(["OAK"]);
    expect(received).toEqual([{ ok: true, value: "declined" }]);
    await expect(
      runtime.start(() => chat.answer(target, { ok: true, value: "approved" })).result,
    ).rejects.toThrow();
    await runtime.start(() => other.answer(second, { ok: true, value: "approved" })).result;
    expect(await runtime.start(() => other.run()).result).toMatchObject({ state: "completed" });
    expect(received.at(-1)).toEqual({ ok: true, value: "approved" });
    expect(peer.bodies[1]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: JSON.stringify({ id: "oak", decision: "declined" }),
        }),
      ]),
    });
  });
  it(`${runtime.name}: aliases share a child recipe but distinct definitions cannot claim its ID`, async () => {
    const makeParent = (name: string, alias: string, child: typeof rg) =>
      defineTool(name)
        .parameters(z.object({}))
        .capabilities({ [alias]: child })
        .execute(function* () {
          return name;
        });
    const first = makeParent("one", "local", rg);
    const peer = await serve(runtime, []);
    const run = { journal: store().open(), sampling: peer.sampling };
    expect(() =>
      defineAgent({ tools: [first, makeParent("two", "other", rg)] }).bind(runtime, program, run),
    ).not.toThrow();
    const shadow = defineTool(rg.id)
      .parameters(rg.context)
      .capabilities(rg.capabilities)
      .execute(rg.body);
    expect(() =>
      defineAgent({ tools: [first, makeParent("two", "local", shadow)] }).bind(
        runtime,
        program,
        run,
      ),
    ).toThrow(/conflicting authored tool/i);
  });
  for (const mode of ["return", "missing", "hidden", "invalid", "ordinary", "ungranted"] as const) {
    it(`${runtime.name}: child routing: ${mode}`, async () => {
      const ordinary = Object.freeze({
        ...defineEffect({ key: "ordinary", context: search.context, response: z.string() }),
        body() {
          throw new Error("Not an authored tool");
        },
      });
      const parent = defineTool("parent")
        .parameters(z.object({ term: z.string() }))
        .capabilities({ child: rg, ordinary })
        .execute(function* ({ term }, ctx) {
          if (mode === "ungranted") {
            return yield* search.call({ pattern: term });
          }
          if (mode === "ordinary") {
            return yield* ctx.capabilities.ordinary({ pattern: term });
          }
          return yield* ctx.capabilities.child(
            mode === "invalid" ? ({} as { term: string }) : { term },
          );
        });
      const call = { name: mode === "hidden" ? rg.id : parent.id, args: { term: "oak" } };
      const fails = mode === "missing" || mode === "invalid" || mode === "ungranted";
      const peer = await serve(runtime, fails ? [call] : [call, null]);
      const journal = store().open();
      const seen: string[] = [];
      const task = runtime.start(function* () {
        yield* journal.admit(program.id, {});
        return yield* defineAgent({ tools: [parent] })
          .bind(runtime, program, {
            journal,
            sampling: peer.sampling,
            *installEffects(effects) {
              if (mode !== "missing") {
                yield* effects.install(
                  mode === "ordinary" ? ordinary : search,
                  function* ({ pattern }) {
                    seen.push(pattern);
                    return { ok: true, value: "hit" };
                  },
                );
              }
            },
          })
          .run();
      });
      if (fails) {
        await expect(task.result).rejects.toThrow(
          mode === "missing"
            ? /handler is not installed/
            : mode === "ungranted"
              ? /not granted/
              : /input|schema/i,
        );
      } else {
        expect(await task.result).toMatchObject({ state: "completed" });
        const value =
          mode === "hidden"
            ? "unknown-tool"
            : mode === "ordinary"
              ? { ok: true, value: "hit" }
              : { ok: true, value: { ok: true, value: "hit" } };
        expect(peer.bodies[1]).toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "tool", content: JSON.stringify(value) }),
          ]),
        });
      }
      expect(seen).toEqual(mode === "ordinary" || mode === "return" ? ["oak"] : []);
    });
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
