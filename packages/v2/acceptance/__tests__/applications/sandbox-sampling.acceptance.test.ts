import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createLuaKernel, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import {
  bindLuaSamplingProgram,
  luaGameCaller,
  structuredLuaCaller,
} from "../../../../../experiments/workflow-kernel/sampling/lua.mts";
import { z } from "zod";
import { sampleSchemaStream } from "../../../../../experiments/workflow-kernel/sampling/structured.mts";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from "@sweatpan.ts/providers";
import { createSchemeKernel } from "@sweatpan.ts/codemode-runtime-scheme";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "@sweatpan.ts/codemode-runtime-scheme/node";
import { createToolAcquisition } from "@sweatpan.ts/tools";
import { createEffectCapabilities } from "@sweatpan.ts/hosting";
import { createProtocolRig, createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { PreparedProgram } from "@sweatpan.ts/execution";
import type { Operation } from "@standard-durability/core";
import {
  gameCaller,
  rpsTool,
  structuredTool,
  structuredCaller,
} from "../../../../../experiments/workflow-kernel/sampling/game.mts";
import { bindSamplingProgram } from "../../../../../experiments/workflow-kernel/sampling/scheme.mts";
import { createSamplingHost } from "../../../../../experiments/workflow-kernel/sampling/hosting.mts";
import { sampleStream } from "../../../../../experiments/workflow-kernel/sampling/provider.mts";
import { prompt } from "../../../../../experiments/workflow-kernel/sampling/contracts.mts";
import { forEachRuntime } from "../runtime/assembly.ts";

const luaBytes = await readFile(luaWasmUrl);
const luaIdentity = createHash("sha256").update(luaBytes).digest("hex");
let luaModule: Promise<WebAssembly.Module> | undefined;
const loadLuaModule = () => (luaModule ??= WebAssembly.compile(luaBytes));
const model = { id: "game-model", provider: "scripted", api: "text" };
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function fixture(language: "scheme" | "tool" | "lua", caller = gameCaller, structured = false) {
    const peer = createProtocolRig();
    const requests: ModelRequest[] = [];
    let restores = 0;
    const provider = createModelProvider(runtime.composition, "game-provider", {
      *stream(request) {
        const id = "sample-" + requests.length;
        requests.push(structuredClone(request));
        let provisional = false;
        return {
          *next(): Operation<IteratorResult<ModelStreamEvent, ModelResponse>, Y> {
            if (!provisional) {
              provisional = true;
              return {
                done: false,
                value: {
                  type: "text-end",
                  contentIndex: 0,
                  content: "unaccepted preview",
                  partial: {
                    role: "assistant",
                    content: [{ type: "text", text: "unaccepted preview" }],
                  },
                },
              };
            }
            const response = yield* runtime.fromPromise((signal) =>
              peer.send({ id, token: JSON.stringify(request) }, signal),
            );
            return {
              done: true,
              value: {
                message: { role: "assistant", content: [{ type: "text", text: response.body }] },
                source: { ...model, model: model.id, responseModel: null },
                usage: null,
                stopReason: "stop",
                responseId: id,
                errorMessage: null,
              },
            };
          },
        };
      },
    });
    const luaArtifact = bindLuaSamplingProgram(
      structured ? structuredLuaCaller : caller === gameCaller ? luaGameCaller : caller,
      luaIdentity,
      model,
    );
    const artifact = bindSamplingProgram(
      language === "lua" ? gameCaller : caller,
      schemeRuntimeIdentity,
      model,
    );
    const program =
      language === "lua"
        ? luaArtifact.program
        : language === "scheme"
          ? artifact.program
          : (structured ? structuredTool.id : rpsTool.id) + JSON.stringify(model);
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, unknown, unknown, Y>({
      program,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    function* prepare(): Operation<PreparedProgram<string, CapabilityRequest, Y>, Y> {
      if (language === "tool") {
        if (structured) {
          const acquisition = createToolAcquisition(
            runtime,
            createEffectCapabilities(runtime, "structured-tool"),
            structuredTool,
            "structured-acquire",
          );
          return { acquire: () => acquisition.operations.acquire(2) };
        }
        const acquisition = createToolAcquisition(
          runtime,
          createEffectCapabilities(runtime, "game-tool"),
          rpsTool,
          "game-tool-acquire",
        );
        return { acquire: () => acquisition.operations.acquire(2) };
      }
      const decodeResult = (value: unknown) => {
        if (typeof value !== "string") {
          throw new Error("Expected game result");
        }
        return value;
      };
      const recipe =
        language === "lua"
          ? yield* createLuaKernel(runtime, {
              loadModule: loadLuaModule,
              decodeRequest: luaArtifact.decodeRequest,
              decodeResult,
            }).prepare(luaArtifact.source, 2)
          : yield* createSchemeKernel(runtime, {
              identity: schemeRuntimeIdentity,
              loadMachine: loadSchemeMachine,
              decodeRequest: artifact.decodeRequest,
              decodeResult,
            }).prepare(artifact.source, 2);
      return {
        ...recipe,
        checkpoints: {
          ...recipe.checkpoints,
          *restore(state: unknown) {
            restores++;
            return yield* recipe.checkpoints.restore(state);
          },
        },
      };
    }
    const host = () =>
      createSamplingHost(runtime, {
        program,
        journal: store.open(),
        model,
        provider: provider.operations,
        prepare,
      });
    function run(command?: Parameters<ReturnType<typeof host>["run"]>[0]) {
      const task = runtime.start(() => host().run(command));
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task;
    }
    return { peer, provider, requests, run, store, restored: () => restores };
  }

  for (const language of ["scheme", "tool", "lua"] as const) {
    it(`${runtime.name} ${language}: structured sampling validates before elicitation and survives reopen`, async () => {
      const rig = fixture(language, structuredCaller, true);
      const task = rig.run();
      await rig.peer.waitForRequests(1);
      expect(rig.requests[0]!.context.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining('"required":["move","reason"]'),
      });
      rig.peer.reply("sample-0", {
        status: 200,
        body: '{"move":"rock","reason":"A solid opening"}',
      });
      const waiting = await task.result;
      if (waiting.state !== "waiting") {
        throw new Error("Expected move");
      }
      expect(waiting.pending.request.input).toEqual({ message: "A solid opening" });
      rig.store.reopen();
      expect(await rig.run().result).toMatchObject({ state: "waiting", grant: waiting.grant });
      expect(await rig.run({ grant: waiting.grant, value: "paper" }).result).toEqual({
        state: "completed",
        value: "player",
      });
      expect(rig.peer.requests).toHaveLength(1);
    });

    it(`${runtime.name} ${language}: structured provider uncertainty is not a schema failure or retry`, async () => {
      const rig = fixture(language, structuredCaller, true);
      const task = rig.run();
      await rig.peer.waitForRequests(1);
      rig.peer.fail("sample-0", new Error("connection lost"));
      await expect(task.result).rejects.toThrow("connection lost");
      rig.store.reopen();
      expect(await rig.run().result).toMatchObject({ state: "occupied" });
      expect(rig.peer.requests).toHaveLength(1);
    });

    for (const [body, reason] of [
      ["not JSON", "invalid-json"],
      ['{"move":"lizard","reason":"oops"}', "schema-mismatch"],
      ['{"move":"rock","reason":"ok","unexpected":true}', "schema-mismatch"],
      ["null", "schema-mismatch"],
    ]) {
      it(`${runtime.name} ${language}: structured ${body} is accepted as invalid without retry`, async () => {
        const rig = fixture(language, structuredCaller, true);
        const task = rig.run();
        await rig.peer.waitForRequests(1);
        rig.peer.reply("sample-0", { status: 200, body: body! });
        expect(await task.result).toEqual({ state: "completed", value: reason });
        rig.store.reopen();
        expect(await rig.run().result).toEqual({ state: "completed", value: reason });
        expect(rig.peer.requests).toHaveLength(1);
      });
    }

    it(`${runtime.name} ${language}: sample and elicit share effects across a two-round durable game`, async () => {
      const rig = fixture(language);
      const firstRun = rig.run();
      await rig.peer.waitForRequests(1);
      expect(rig.requests[0]).toEqual({
        context: { messages: [{ role: "user", content: prompt + "2" }], tools: [] },
        options: { toolChoice: "none", maxTokens: 4096 },
      });
      rig.peer.reply("sample-0", { status: 200, body: "rock" });
      const first = await firstRun.result;
      if (first.state !== "waiting") {
        throw new Error("Expected player move");
      }
      expect(first.pending.request.input).toEqual({
        message: "Choose rock, paper, or scissors. Round 2",
      });
      rig.store.reopen();
      expect(await rig.run().result).toMatchObject({ state: "waiting", grant: first.grant });
      expect(rig.peer.requests).toHaveLength(1);
      await expect(rig.run({ grant: first.grant, value: "lizard" }).result).rejects.toThrow(
        "Effect schema rejected value",
      );
      const secondRun = rig.run({ grant: first.grant, value: "paper" });
      await rig.peer.waitForRequests(2);
      expect(rig.requests[1]!.context.messages).toEqual([{ role: "user", content: prompt + "1" }]);
      rig.peer.reply("sample-1", { status: 200, body: "scissors" });
      const second = await secondRun.result;
      if (second.state !== "waiting") {
        throw new Error("Expected second player move");
      }
      rig.store.reopen();
      expect(await rig.run({ grant: second.grant, value: "paper" }).result).toEqual({
        state: "completed",
        value: "player;model;",
      });
      expect(await rig.run().result).toEqual({ state: "completed", value: "player;model;" });
      expect(rig.peer.requests).toHaveLength(2);
      if (language !== "tool") {
        expect(rig.restored()).toBeGreaterThanOrEqual(2);
      }
    });

    it(`${runtime.name} ${language}: invalid model moves end the game without an elicit or hidden retry`, async () => {
      const rig = fixture(language);
      const task = rig.run();
      await rig.peer.waitForRequests(1);
      rig.peer.reply("sample-0", { status: 200, body: "lizard" });
      expect(await task.result).toEqual({ state: "completed", value: "invalid model move" });
      expect(rig.peer.requests).toHaveLength(1);
    });

    it(`${runtime.name} ${language}: an ambiguous provider failure stays occupied across reopen`, async () => {
      const rig = fixture(language);
      const task = rig.run();
      await rig.peer.waitForRequests(1);
      rig.peer.fail("sample-0", new Error("connection lost after request"));
      await expect(task.result).rejects.toThrow("connection lost");
      rig.store.reopen();
      expect(await rig.run().result).toMatchObject({ state: "occupied" });
      expect(rig.peer.requests).toHaveLength(1);
    });

    it(`${runtime.name} ${language}: physical interruption aborts sampling without granting a retry; logical cancel stops the loop`, async () => {
      const rig = fixture(language);
      const task = rig.run();
      await rig.peer.waitForRequests(1);
      await task.cancel();
      expect(rig.peer.aborted).toEqual(["sample-0"]);
      rig.store.reopen();
      expect(await rig.run().result).toMatchObject({ state: "occupied" });
      const snapshot = await runtime.start(() => rig.store.open().read()).result;
      if (snapshot.status !== "running" || !snapshot.pending) {
        throw new Error("Expected occupied sample");
      }
      expect(await rig.run({ cancel: snapshot.pending.id }).result).toMatchObject({
        state: "cancelled",
        reason: "player stopped",
      });
      expect(rig.peer.requests).toHaveLength(1);
    });

    it(`${runtime.name} ${language}: cancellation while waiting for a move does not sample the next round`, async () => {
      const rig = fixture(language);
      const task = rig.run();
      await rig.peer.waitForRequests(1);
      rig.peer.reply("sample-0", { status: 200, body: "paper" });
      const waiting = await task.result;
      if (waiting.state !== "waiting") {
        throw new Error("Expected move");
      }
      rig.store.reopen();
      expect(await rig.run({ cancel: waiting.grant.requestId }).result).toMatchObject({
        state: "cancelled",
      });
      expect(rig.peer.requests).toHaveLength(1);
    });
  }

  it(`${runtime.name}: structured streams preserve provisional events and accept schema-valid null`, async () => {
    const rig = fixture("tool");
    const task = runtime.start(function* () {
      const stream = yield* sampleSchemaStream(
        rig.provider.operations,
        model,
        { prompt: "Return null" },
        z.null(),
      );
      expect((yield* stream.next()).done).toBe(false);
      return yield* stream.next();
    });
    onTestFinished(() => task.cancel());
    await rig.peer.waitForRequests(1);
    rig.peer.reply("sample-0", { status: 200, body: "null" });
    expect(await task.result).toMatchObject({
      done: true,
      value: { valid: true, value: null, sample: { text: "null", responseId: "sample-0" } },
    });
  });

  for (const caller of [
    'return sample({prompt = "hello", model = "ungranted"})',
    'return sampleSchema({prompt = "hello", schema = "ungranted"})',
    "return elicit({message = 123})",
    'return workflow.effect("unknown", {effect = "ungranted", input = "hello"})',
  ]) {
    it(`${runtime.name}: Lua rejects ungranted or malformed sampling: ${caller}`, async () => {
      const rig = fixture("lua", caller);
      const before = await runtime.start(() => rig.store.open().read()).result;
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(rig.run().result).rejects.toThrow();
        const after = await runtime.start(() => rig.store.open().read()).result;
        expect(after.status).toBe(before.status);
        expect(after.revision).toBe(before.revision);
        expect(after).not.toHaveProperty("pending");
        rig.store.reopen();
      }
      expect(rig.peer.requests).toHaveLength(0);
    });
  }

  it(`${runtime.name}: malformed sandbox samples reject before provider delivery`, async () => {
    const rig = fixture(
      "scheme",
      '(sample (object (list "prompt" "hello") (list "model" "ungranted")))',
    );
    await expect(rig.run().result).rejects.toThrow();
    expect(rig.peer.requests).toHaveLength(0);
  });

  it(`${runtime.name}: sample streaming retains only explicitly supplied history and exposes provisional events separately`, async () => {
    const rig = fixture("scheme");
    const task = runtime.start(function* () {
      yield* rig.provider.around({
        *stream([request], next) {
          return yield* next({ ...request, options: { ...request.options, maxTokens: 64 } });
        },
      });
      const stream = yield* sampleStream(rig.provider.operations, model, {
        prompt: "next",
        systemPrompt: "be brief",
        history: [
          { role: "user", content: "prior" },
          { role: "assistant", content: "reply" },
        ],
        maxTokens: 100,
      });
      expect((yield* stream.next()).done).toBe(false);
      return yield* stream.next();
    });
    onTestFinished(() => task.cancel());
    await rig.peer.waitForRequests(1);
    expect(rig.requests[0]!.context.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "prior" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "next" },
    ]);
    expect(rig.requests[0]!.options?.maxTokens).toBe(64);
    rig.peer.reply("sample-0", { status: 200, body: "accepted completion" });
    expect(await task.result).toEqual({
      done: true,
      value: { text: "accepted completion", model, responseId: "sample-0" },
    });
  });
});
