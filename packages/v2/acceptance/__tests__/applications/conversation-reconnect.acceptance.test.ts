import { conversationText } from "@sweatpan.ts/chat-client";
import { createConversationViewer } from "../../examples/conversation-viewer.ts";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ModelInfo, ModelResponse } from "@sweatpan.ts/providers";
import {
  createHostedRecovery,
  createSqliteDatabaseRig,
  createProtocolRig,
  createLatch,
} from "@sweatpan.ts/testing";
import { createFileConversation } from "../../examples/file-conversation.ts";
import {
  createFileConversationView,
  type ConversationView,
} from "../../examples/file-conversation-view.ts";
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
function response(text: string, tool = false): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        {
          type: "reasoning",
          text: "private-reasoning",
          format: null,
          signature: null,
          redacted: false,
        },
        ...(tool
          ? [
              {
                type: "tool-call" as const,
                toolCall: {
                  id: "read-first",
                  name: "read_file",
                  input: { path: "first.txt", mode: "single" },
                  thoughtSignature: "private-signature",
                },
              },
            ]
          : []),
      ],
    },
    source: { api: "scripted", provider: "test", model: "planner", responseModel: null },
    usage: null,
    stopReason: tool ? "toolUse" : "stop",
    responseId: null,
    errorMessage: null,
  };
}
// A serialized in-process peer boundary, not a live HTTP or authentication adapter.
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: a fresh conversation viewer recovers a waiting tool and a lost answer acknowledgement without advancing chat`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const peer = createProtocolRig();
    let acquisitions = 0;
    function task<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution;
    }
    function assemble(id = "conversation") {
      const conversation = createFileConversation(runtime, database.database, id, {
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
                  id: `model-${peer.requests.length}`,
                  token: JSON.stringify(request),
                },
                signal,
              ),
            );
            return {
              ok: true,
              value: { model, response: JSON.parse(reply.body) as ModelResponse },
            };
          },
        },
      });
      return { conversation, server: createFileConversationView(runtime, id, conversation) };
    }
    let app = assemble();
    let loseAnswer = false;
    let held:
      | {
          captured: ReturnType<typeof createLatch<void>>;
          release: ReturnType<typeof createLatch<void>>;
        }
      | undefined;
    function connect() {
      // Bind to this connection's assembly, never retain it across DB reopen.
      const server = app.server;
      return createConversationViewer({
        async observe() {
          const view = wire(await task(() => server.observe()).result);
          const delay = held;
          if (delay) {
            held = undefined;
            delay.captured.resolve();
            await delay.release.promise;
          }
          return view;
        },
        async answer(command) {
          const receipt = wire(await task(() => server.answer(wire(command))).result);
          if (loseAnswer) {
            loseAnswer = false;
            throw new Error("Lost answer acknowledgement");
          }
          return receipt;
        },
      });
    }
    const submitted = await task(() =>
      app.conversation.submit({ command: "first", prompt: "Read my file.", after: null }),
    ).result;
    let viewer = connect();
    await viewer.refresh();
    expect(
      viewer.view?.turns[0]?.messages.map((message) => conversationText(message.parts)),
    ).toEqual(["Read my file."]);
    expect(acquisitions).toBe(0);
    expect(peer.requests).toHaveLength(0);

    const running = task(() => app.conversation.turn(submitted.execution).run());
    await Promise.race([peer.waitForRequests(1), running.result]);
    // Observing and disconnecting during a live sample cannot stop its owner.
    await viewer.refresh();
    expect(viewer.view?.questions).toEqual([]);
    expect(viewer.view?.turns[0]?.status).toBe("running");
    viewer.close();
    expect(peer.aborted).toEqual([]);
    peer.reply("model-0", {
      status: 200,
      body: JSON.stringify(response("I need the file.", true)),
    });
    expect(await running.result).toMatchObject({ state: "child", reason: "waiting" });
    viewer = connect();
    await viewer.refresh();
    const waiting = wire(viewer.view!);
    const question = waiting.questions[0]!;
    expect(waiting.questions).toHaveLength(1);
    expect(question.context).toEqual({ path: "first.txt", step: "read" });
    expect(waiting.turns[0]?.messages.map((message) => conversationText(message.parts))).toEqual([
      "Read my file.",
      "I need the file.",
    ]);
    expect(waiting.turns[0]?.messages[1]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-call", callId: "read-first", name: "read_file" }),
      ]),
    );
    expect(JSON.stringify(waiting)).not.toContain("private-signature");
    expect(JSON.stringify(waiting)).not.toContain("private-reasoning");
    expect(JSON.stringify(waiting)).not.toContain("declaration");
    const beforeReads = acquisitions;
    await viewer.refresh();
    expect(viewer.view).toEqual(waiting);
    viewer.close();
    database.reopen();
    app = assemble();
    viewer = connect();
    await viewer.refresh();
    expect(viewer.view).toEqual(waiting);
    expect(acquisitions).toBe(beforeReads);
    expect(peer.requests).toHaveLength(1);

    const other = assemble("other-conversation");
    const foreign = await task(() =>
      other.conversation.submit({ command: "other", prompt: "Other", after: null }),
    ).result;
    await expect(
      task(() => other.server.answer({ ...question, text: "stolen" })).result,
    ).rejects.toThrow("outside this conversation");
    await expect(
      task(() =>
        app.server.answer({ ...question, execution: foreign.execution, text: "misrouted" }),
      ).result,
    ).rejects.toThrow();
    await viewer.refresh();
    expect(viewer.view).toEqual(waiting);

    // Hold an old read, accept the answer, then deliver a newer read first.
    const delay = { captured: createLatch<void>(), release: createLatch<void>() };
    held = delay;
    const stale = viewer.refresh();
    await delay.captured.promise;
    loseAnswer = true;
    await expect(viewer.answer(question, "accepted file")).rejects.toThrow(
      "Lost answer acknowledgement",
    );
    await viewer.refresh();
    expect(viewer.view?.questions).toEqual([]);
    expect(viewer.view?.turns[0]?.status).toBe("running");
    delay.release.resolve();
    await stale;
    expect(viewer.view?.questions).toEqual([]);
    viewer.close();
    database.reopen();
    app = assemble();
    viewer = connect();
    await viewer.refresh();
    expect(viewer.view?.questions).toEqual([]);
    expect(viewer.view?.turns[0]?.messages.map((message) => message.id)).toEqual(
      waiting.turns[0]?.messages.map((message) => message.id),
    );
    const duplicate = await viewer.answer(question, "accepted file");
    expect(duplicate.duplicate).toBe(true);
    expect((await viewer.answer(question, "accepted file")).receipt).toBe(duplicate.receipt);
    await expect(viewer.answer(question, "different answer")).rejects.toThrow();
    expect(acquisitions).toBe(beforeReads);
    expect(peer.requests).toHaveLength(1);

    const finishing = task(() => app.conversation.turn(submitted.execution).run());
    await Promise.race([peer.waitForRequests(2), finishing.result]);
    expect(JSON.parse(peer.requests[1]!.token).history).toContainEqual(
      expect.objectContaining({ role: "tool", content: "accepted file" }),
    );
    peer.reply("model-1", { status: 200, body: JSON.stringify(response("File handled.")) });
    expect(await finishing.result).toMatchObject({ state: "completed" });
    await viewer.refresh();
    const completed = wire(viewer.view!);
    expect(completed.turns[0]?.status).toBe("completed");
    expect(completed.turns[0]?.messages.map((message) => conversationText(message.parts))).toEqual([
      "Read my file.",
      "I need the file.",
      "File handled.",
    ]);
    expect(completed.turns[0]?.messages.slice(0, 2).map((message) => message.id)).toEqual(
      waiting.turns[0]?.messages.map((message) => message.id),
    );
    await viewer.refresh();
    expect(viewer.view).toEqual(completed);
    viewer.close();
    database.reopen();
    app = assemble();
    viewer = connect();
    await viewer.refresh();
    expect(viewer.view).toEqual(completed);

    // A second turn's cumulative model history must not duplicate displayed messages.
    const second = await task(() =>
      app.conversation.submit({ command: "second", prompt: "Thanks.", after: submitted.execution }),
    ).result;
    const nextTurn = task(() => app.conversation.turn(second.execution).run());
    await Promise.race([peer.waitForRequests(3), nextTurn.result]);
    peer.reply("model-2", { status: 200, body: JSON.stringify(response("You're welcome.")) });
    expect(await nextTurn.result).toMatchObject({ state: "completed" });
    const finalAcquisitions = acquisitions;
    await viewer.refresh();
    const final: ConversationView = viewer.view!;
    expect(final.turns).toHaveLength(2);
    expect(final.turns[0]).toEqual(completed.turns[0]);
    const messages = final.turns.flatMap((turn) => turn.messages);
    expect(messages.map((message) => conversationText(message.parts))).toEqual([
      "Read my file.",
      "I need the file.",
      "File handled.",
      "Thanks.",
      "You're welcome.",
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    await viewer.refresh();
    expect(viewer.view).toEqual(final);
    expect(acquisitions).toBe(finalAcquisitions);
    expect(peer.requests).toHaveLength(3);
    viewer.close();
    expect(viewer.view).toBeUndefined();
    await expect(viewer.refresh()).rejects.toThrow("closed");
  });
});
