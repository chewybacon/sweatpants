import {
  materializeConversation,
  type ConversationPart,
  type ConversationNode,
} from "@sweatpan.ts/chat-client";
import type { FileQuestionContract } from "../../examples/file-conversation-view.ts";
import { act, fireEvent, within, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import { isDeepStrictEqual } from "node:util";
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
import { createFileConversationView } from "../../examples/file-conversation-view.ts";
import { createFileConversationClient } from "../../examples/file-conversation-client.tsx";
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

forEachRuntime(<Y,>(runtime: Runtime<Y>) => {
  for (const mode of ["acknowledged", "lost-retry", "lost-reconnect", "not-delivered"] as const) {
    it(`${runtime.name}: typed file question UI (${mode})`, async () => {
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
      function assemble() {
        const conversation = createFileConversation(runtime, database.database, "ui-conversation", {
          matches: isDeepStrictEqual,
          recovery: <R,>(
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
                    id: `ui-model-${peer.requests.length}`,
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
        return {
          conversation,
          server: createFileConversationView(runtime, "ui-conversation", conversation),
        };
      }
      let app = assemble();
      const submitted = await task(() =>
        app.conversation.submit({ command: "first", prompt: "Read my file.", after: null }),
      ).result;
      const run = task(() => app.conversation.turn(submitted.execution).run());
      await Promise.race([peer.waitForRequests(1), run.result]);
      peer.reply("ui-model-0", {
        status: 200,
        body: JSON.stringify(response("I need the file.", true)),
      });
      expect(await run.result).toMatchObject({ state: "child", reason: "waiting" });
      const beforeReads = acquisitions;
      const started = createLatch<void>();
      const release = createLatch<void>();
      onTestFinished(() => release.resolve());
      const sent: string[] = [];
      const receipts: { receipt: string; duplicate: boolean }[] = [];
      const container = document.createElement("div");
      document.body.append(container);
      const mounted = within(container);
      function connect(observed?: {
        ready: ReturnType<typeof createLatch<void>>;
        release: ReturnType<typeof createLatch<void>>;
      }) {
        const server = app.server;
        return createFileConversationClient(container, {
          async observe() {
            const view = wire(await task(() => server.observe()).result);
            if (observed) {
              observed.ready.resolve();
              await observed.release.promise;
            }
            return view;
          },
          async answer(command) {
            sent.push(command.text);
            const first = sent.length === 1;
            if (first) {
              started.resolve();
              await release.promise;
            }
            if (first && mode === "not-delivered") {
              throw new Error("Connection lost before delivery");
            }
            const receipt = wire(await task(() => server.answer(wire(command))).result);
            receipts.push(receipt);
            if (first && mode.startsWith("lost-")) {
              throw new Error("Acknowledgement lost");
            }
            return receipt;
          },
        });
      }
      let client: ReturnType<typeof connect>;
      act(() => {
        client = connect();
      });
      onTestFinished(() => {
        act(() => {
          client.dispose();
        });
        container.remove();
      });
      const input = await mounted.findByRole("textbox", { name: "File contents" });
      expect(mounted.getByText("I need the file.")).toBeTruthy();
      expect(
        mounted.getByRole("button", { name: "Send answer" }).getAttribute("disabled"),
      ).not.toBeNull();
      expect(sent).toEqual([]);
      expect(acquisitions).toBe(beforeReads);
      fireEvent.change(input, { target: { value: "accepted file" } });
      fireEvent.click(mounted.getByRole("button", { name: "Send answer" }));
      await started.promise;
      expect(mounted.getByText("Sending answer…")).toBeTruthy();
      expect((input as HTMLTextAreaElement).disabled).toBe(true);
      // Even a second submit event before the reply cannot send another command.
      fireEvent.submit(input.closest("form")!);
      expect(sent).toEqual(["accepted file"]);
      await act(async () => {
        release.resolve();
      });

      if (mode === "acknowledged") {
        await mounted.findByText("Answer accepted.");
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.duplicate).toBe(false);
      } else {
        await mounted.findByText(
          "Answer not confirmed. Retry the same answer or reconnect to check the conversation.",
        );
        expect(mounted.queryByText("Answer accepted.")).toBeNull();
        if (mode !== "lost-reconnect") {
          fireEvent.click(mounted.getByRole("button", { name: "Retry same answer" }));
          await mounted.findByText("Answer accepted.");
          expect(sent).toEqual(["accepted file", "accepted file"]);
          expect(receipts.at(-1)?.duplicate).toBe(mode === "lost-retry");
          if (mode === "lost-retry") {
            expect(receipts[0]?.receipt).toBe(receipts[1]?.receipt);
          }
        } else {
          fireEvent.click(mounted.getByRole("button", { name: "Reconnect" }));
          await mounted.findByText("No questions awaiting an answer.");
          // Absence is deliberately not labelled accepted without a receipt.
          expect(mounted.queryByText("Answer accepted.")).toBeNull();
        }
      }
      expect(acquisitions).toBe(beforeReads);
      expect(peer.requests).toHaveLength(1);
      act(() => {
        client.dispose();
        client.dispose();
      });
      expect(container.childElementCount).toBe(0);
      database.reopen();
      app = assemble();
      act(() => {
        client = connect();
      });
      await mounted.findByText("No questions awaiting an answer.");
      expect(mounted.queryByRole("textbox")).toBeNull();
      expect(mounted.getByText("Turn not complete.")).toBeTruthy();
      expect(mounted.queryByText("Answer accepted.")).toBeNull();
      expect(acquisitions).toBe(beforeReads);
      expect(peer.requests).toHaveLength(1);

      const finishing = task(() => app.conversation.turn(submitted.execution).run());
      await Promise.race([peer.waitForRequests(2), finishing.result]);
      act(() => {
        client.dispose();
        client.dispose();
      });
      expect(container.childElementCount).toBe(0);
      expect(peer.aborted).toEqual([]);
      peer.reply("ui-model-1", { status: 200, body: JSON.stringify(response("File handled.")) });
      expect(await finishing.result).toMatchObject({ state: "completed" });
      act(() => {
        client = connect();
      });
      await mounted.findByText("File handled.");
      await waitFor(() => expect(mounted.getByText("Turn complete.")).toBeTruthy());
      expect(mounted.queryByRole("textbox")).toBeNull();
      expect(peer.requests).toHaveLength(2);
      // A read already in flight may finish after client disposal. It must not
      // recreate the DOM or interfere with a fresh client in the same container.
      const observed = { ready: createLatch<void>(), release: createLatch<void>() };
      onTestFinished(() => observed.release.resolve());
      act(() => {
        client.dispose();
        client = connect(observed);
      });
      await observed.ready.promise;
      act(() => {
        client.dispose();
        client = connect();
      });
      await mounted.findByText("File handled.");
      await act(async () => {
        observed.release.resolve();
      });
      expect(mounted.getAllByRole("main")).toHaveLength(1);
      expect(mounted.getAllByText("File handled.")).toHaveLength(1);
      expect(peer.requests).toHaveLength(2);
    });
  }
});

forEachRuntime(<Y,>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: portable conversation tree retains overlapping tool history`, async () => {
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
    function assemble() {
      const conversation = createFileConversation(runtime, database.database, "tree-conversation", {
        matches: isDeepStrictEqual,
        recovery: <R,>(
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
                { id: `tree-model-${peer.requests.length}`, token: JSON.stringify(request) },
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
      return {
        conversation,
        server: createFileConversationView(runtime, "tree-conversation", conversation),
      };
    }
    let app = assemble();
    const admitted = await task(() =>
      app.conversation.submit({ command: "first", prompt: "Read and review files.", after: null }),
    ).result;
    const first = task(() => app.conversation.turn(admitted.execution).run());
    await peer.waitForRequests(1);
    const initial = response("Working on both files.", true);
    (initial.message.content as Array<(typeof initial.message.content)[number]>).push({
      type: "tool-call",
      toolCall: {
        id: "review-second",
        name: "review_file",
        thoughtSignature: null,
        input: { path: "second.txt" },
      },
    });
    peer.reply("tree-model-0", { status: 200, body: JSON.stringify(initial) });
    expect(await first.result).toMatchObject({ state: "child", reason: "waiting" });
    const read = () => task(() => app.server.observe()).result;
    const waiting = await read();
    expect(waiting.questions.map((question) => question.context.path)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const ui = within(container);
    function connect() {
      const server = app.server;
      return createFileConversationClient(container, {
        observe: async () => wire(await task(() => server.observe()).result),
        answer: async (command) => wire(await task(() => server.answer(wire(command))).result),
      });
    }
    let client: ReturnType<typeof connect>;
    act(() => {
      client = connect();
    });
    onTestFinished(() => {
      act(() => client.dispose());
      container.remove();
    });
    const second = within(await ui.findByRole("region", { name: "Question about second.txt" }));
    fireEvent.change(second.getByRole("textbox"), { target: { value: "Review this content" } });
    fireEvent.click(second.getByRole("button", { name: "Send answer" }));
    await second.findByText("Answer accepted.");
    const reviewing = task(() => app.conversation.turn(admitted.execution).run());
    await peer.waitForRequests(2);
    // The first tool is still waiting while its sibling samples.
    expect((await read()).questions.map((question) => question.context.path)).toEqual([
      "first.txt",
    ]);
    peer.reply("tree-model-1", { status: 200, body: JSON.stringify(response("Nested review.")) });
    expect(await reviewing.result).toMatchObject({ state: "child", reason: "waiting" });
    const beforeReads = acquisitions;
    const partial = await read();
    const tools = partial.turns[0]!.messages[1]!.parts.filter((part) => part.type === "tool-call");
    expect(tools.map((tool) => [tool.callId, tool.state])).toEqual([
      ["read-first", "running"],
      ["review-second", "completed"],
    ]);
    expect(tools[1]!.parts.map((part) => part.type)).toEqual(["question", "message"]);
    expect(tools[1]!.parts[0]).toMatchObject({
      id: waiting.questions[1]!.id,
      state: "answered",
      response: "Review this content",
    });
    expect(JSON.stringify(partial)).not.toMatch(/private-reasoning|private-signature/);
    act(() => client.dispose());
    database.reopen();
    app = assemble();
    expect(await read()).toEqual(partial);
    expect(acquisitions).toBe(beforeReads);
    act(() => {
      client = connect();
    });
    await ui.findByText("Nested review.");
    const firstQuestion = within(ui.getByRole("region", { name: "Question about first.txt" }));
    fireEvent.change(firstQuestion.getByRole("textbox"), { target: { value: "First file" } });
    fireEvent.click(firstQuestion.getByRole("button", { name: "Send answer" }));
    await firstQuestion.findByText("Answer accepted.");
    const finishing = task(() => app.conversation.turn(admitted.execution).run());
    await peer.waitForRequests(3);
    peer.reply("tree-model-2", { status: 200, body: JSON.stringify(response("Both handled.")) });
    expect(await finishing.result).toMatchObject({ state: "completed" });
    const completed = await read();
    const accepted = acquisitions;
    act(() => client.dispose());
    database.reopen();
    app = assemble();
    expect(await read()).toEqual(completed);
    expect(acquisitions).toBe(accepted);
    expect(completed.questions).toEqual([]);
    act(() => {
      client = connect();
    });
    await ui.findByText("Both handled.");
    expect(ui.queryByRole("textbox")).toBeNull();
    expect(ui.getAllByText("Answer recorded.", { exact: false })).toHaveLength(2);
    expect(
      within(ui.getByRole("region", { name: "Tool: review_file" })).getByText("Nested review."),
    ).toBeTruthy();

    // A non-React consumer traverses the same serialized parts. Reordering the
    // input records does not change explicit placement; missing parents reject.
    const roots = wire(completed.turns[0]!.messages);
    const flattened: ConversationNode<FileQuestionContract>[] = [];
    function visit(
      parts: readonly ConversationPart<FileQuestionContract>[],
      parentId: string | null,
    ) {
      parts.forEach((part, order) => {
        if (part.type === "message" || part.type === "tool-call") {
          const { parts: children, ...value } = part;
          flattened.push({ ...value, parentId, order });
          visit(children, part.id);
        } else {
          flattened.push({ ...part, parentId, order });
        }
      });
    }
    visit(roots, null);
    expect(materializeConversation([...flattened].reverse())).toEqual(roots);
    const missingParent = flattened.filter((node) => node.id !== tools[1]!.id);
    expect(() => materializeConversation(missingParent)).toThrow("Missing conversation parent");
    expect(peer.requests).toHaveLength(3);
  });
});
