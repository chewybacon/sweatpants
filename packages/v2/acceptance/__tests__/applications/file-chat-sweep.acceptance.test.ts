import { isDeepStrictEqual } from "node:util";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { expect, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatLoopRequest } from "@sweatpan.ts/chat";
import { createActivationIntents } from "@sweatpan.ts/durable";
import { createActivationReconciler } from "@sweatpan.ts/deployment";
import type { ModelInfo, ModelResponse } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";

import {
  createHostedRecovery,
  createProtocolRig,
  createSqliteDatabaseRig,
} from "@sweatpan.ts/testing";
import type { ToolInteraction } from "@sweatpan.ts/tools";
import { createFileChat, fileChatProgram } from "../../examples/file-chat.ts";
import { createPersistedSweep } from "../../examples/persisted-sweep.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

const model: ModelInfo = {
  id: "planner",
  provider: "test",
  api: "scripted",
  name: "Planner",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: ["off"],
};
function response(tools: boolean): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: tools
        ? ["single", "cleanup"].map((mode) => ({
            type: "tool-call" as const,
            toolCall: {
              id: mode,
              name: "read_file",
              input: { path: `${mode}.txt`, mode },
              thoughtSignature: null,
            },
          }))
        : [{ type: "text", text: "Files handled." }],
    },
    source: { api: "scripted", provider: "test", model: "planner", responseModel: null },
    usage: {
      input: 10,
      output: 5,
      total: 15,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      cacheWrite1h: null,
      cost: null,
    },
    reasoning: { requested: null, provider: null },
    stopReason: tools ? "toolUse" : "stop",
    responseId: tools ? "first" : "last",
    errorMessage: null,
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function task<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function application() {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const peer = createProtocolRig();
    let acquisitions = 0;
    function assemble() {
      const db = database.database;
      const sweep = createPersistedSweep(db);
      function bind(id: string, program = fileChatProgram) {
        if (program !== fileChatProgram) {
          throw new Error("Unavailable chat program");
        }
        const store = createSqliteJournalStore<
          string,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          connection: createNodeSqliteConnection(db),
          id,
          program,
          equals: isDeepStrictEqual,
          serialization: {
            *resolve() {
              return v8Serializer;
            },
          },
        });
        const journal = store.open();
        const intents = createActivationIntents(
          runtime.composition,
          `intents:${id}`,
          store.activations,
        );
        const chat = createFileChat(runtime, journal, {
          matches: isDeepStrictEqual,
          recovery: <R>(
            options: Parameters<
              typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
            >[1],
          ) =>
            createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, {
              ...options,
              *acquire() {
                acquisitions++;
                return yield* options.acquire();
              },
            }),
          sampling: {
            *sample(request) {
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send(
                  {
                    id: `${id}:${request.round}`,
                    token: JSON.stringify(request),
                  },
                  signal,
                ),
              );
              // Scripted protocol peer supplies the typed fixture envelope; this is not a wire adapter.
              return {
                ok: true,
                value: { model, response: JSON.parse(reply.body) as ModelResponse },
              };
            },
          },
        });
        return { journal, intents, chat };
      }
      return {
        bind,
        *submit(id: string) {
          sweep.enroll(id, fileChatProgram); // Persist discovery before journal admission.
          return yield* bind(id).journal.admit(fileChatProgram, { prompt: "Read the files." });
        },
        // One designated caller owns each invocation; no request, reader or notification starts it.
        *tick() {
          return yield* sweep.tick(function* (id, program) {
            const { journal, intents, chat } = bind(id, program);
            const snapshot = yield* journal.read();
            if (snapshot.status === "running" && !snapshot.admission) {
              return { id, state: "unadmitted" as const };
            }
            const reconciler = createActivationReconciler(runtime.composition, `chat:${id}`, {
              intents,
              run: chat.run,
            });
            return {
              id,
              state: "visited" as const,
              report: yield* reconciler.operations.reconcile(),
            };
          });
        },
      };
    }
    return {
      database,
      peer,
      assemble,
      get acquisitions() {
        return acquisitions;
      },
    };
  }
  async function observe(chat: ReturnType<typeof createFileChat<Y>>) {
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

  it(`${runtime.name}: persisted sweep resumes file chat after lost nested-answer responses`, async () => {
    const scenario = application();
    let app = scenario.assemble();
    await task(() => app.submit("chat")).result;
    const first = task(app.tick);
    await Promise.race([scenario.peer.waitForRequests(1), first.result]);
    scenario.peer.reply("chat:0", { status: 200, body: JSON.stringify(response(true)) });
    expect(await first.result).toMatchObject({
      report: { result: { state: "child", reason: "waiting" } },
    });
    const questions = await observe(app.bind("chat").chat);
    expect(questions).toHaveLength(2);
    const cleanup = questions.find((item) => item.scope?.phase === "cleanup")!;
    const body = questions.find((item) => item !== cleanup)!;
    expect(cleanup.input).toEqual({ path: "cleanup.txt", step: "repair" });
    // Reach a quiescent wait before ingress, so the answer must create fresh root intent.
    expect(await task(app.tick).result).toEqual({ state: "wrapped" });
    expect(await task(app.tick).result).toMatchObject({ report: { acknowledged: true } });
    expect(await task(app.bind("chat").intents.operations.read).result).toBeUndefined();

    async function loseAnswer(item: ToolInteraction) {
      await expect(
        task(function* () {
          yield* app.bind("chat").chat.answer(item, { ok: true, value: "file contents" });
          throw new Error("Answer response lost before scheduling");
        }).result,
      ).rejects.toThrow("response lost");
    }
    const beforeAnswer = scenario.acquisitions;
    await loseAnswer(body);
    expect(scenario.acquisitions).toBe(beforeAnswer);
    expect(await task(app.bind("chat").intents.operations.read).result).toBeDefined();
    expect(scenario.peer.requests).toHaveLength(1);
    scenario.database.reopen();
    app = scenario.assemble();
    // The persisted cursor resumes after this root, then wraps; no client resume command.
    expect(await task(app.tick).result).toEqual({ state: "wrapped" });
    expect(await task(app.tick).result).toMatchObject({
      report: { result: { state: "child", reason: "waiting" } },
    });
    const remaining = await observe(app.bind("chat").chat);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.grant).toEqual(cleanup.grant);
    expect(await task(app.bind("chat").journal.read).result).toMatchObject({ status: "running" });
    expect(scenario.peer.requests).toHaveLength(1);
    expect(
      await task(() => app.bind("chat").chat.answer(body, { ok: true, value: "file contents" }))
        .result,
    ).toMatchObject({ duplicate: true });

    await loseAnswer(cleanup);
    scenario.database.reopen();
    app = scenario.assemble();
    expect(await observe(app.bind("chat").chat)).toEqual([]);
    expect(await task(app.tick).result).toEqual({ state: "wrapped" });
    const finishing = task(app.tick);
    await Promise.race([scenario.peer.waitForRequests(2), finishing.result]);
    const request = JSON.parse(scenario.peer.requests[1]!.token) as ChatLoopRequest;
    expect(
      request.history
        .filter((entry) => entry.role === "tool")
        .map((entry) => ({
          id: entry.toolCallId,
          content: entry.content,
        })),
    ).toEqual([
      { id: "single", content: "file contents" },
      { id: "cleanup", content: "cleaned" },
    ]);
    scenario.peer.reply("chat:1", { status: 200, body: JSON.stringify(response(false)) });
    expect(await finishing.result).toMatchObject({
      report: { result: { state: "completed", value: "Files handled." } },
    });
    scenario.database.reopen();
    app = scenario.assemble();
    const terminalAcquisitions = scenario.acquisitions;
    expect(
      await task(() => app.bind("chat").chat.answer(cleanup, { ok: true, value: "file contents" }))
        .result,
    ).toMatchObject({ duplicate: true });
    expect(await task(app.tick).result).toEqual({ state: "wrapped" });
    expect(await task(app.tick).result).toMatchObject({ report: { acknowledged: true } });
    expect(await task(app.bind("chat").intents.operations.read).result).toBeUndefined();
    expect(await task(app.tick).result).toEqual({ state: "wrapped" });
    expect(await task(app.tick).result).toMatchObject({ report: { state: "idle" } });
    expect(scenario.acquisitions).toBe(terminalAcquisitions);
    expect(scenario.peer.requests.map((entry) => entry.id)).toEqual(["chat:0", "chat:1"]);
  });

  it(`${runtime.name}: a later chat sweep cannot retry interrupted unsafe sampling`, async () => {
    const scenario = application();
    let app = scenario.assemble();
    await task(() => app.submit("chat")).result;
    const active = task(app.tick);
    await Promise.race([scenario.peer.waitForRequests(1), active.result]);
    await active.cancel();
    expect(scenario.peer.aborted).toEqual(["chat:0"]);
    scenario.database.reopen();
    app = scenario.assemble();
    // Interrupted visit never checkpointed its cursor. Recovery still cannot redeliver the attempt.
    expect(await task(app.tick).result).toMatchObject({
      report: {
        acknowledged: false,
        result: { state: "occupied" },
      },
    });
    expect(await task(app.bind("chat").intents.operations.read).result).toBeDefined();
    expect(scenario.peer.requests).toHaveLength(1);
    expect(await observe(app.bind("chat").chat)).toEqual([]);
  });
});
