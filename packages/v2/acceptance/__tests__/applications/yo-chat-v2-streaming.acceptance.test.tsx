import { StrictMode } from "react";
import { act, render, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import { createPullStream, type Runtime } from "@sweatpan.ts/runtime";
import { createLatch, createSqliteDatabaseRig } from "@sweatpan.ts/testing";
import type { Outcome } from "@standard-durability/core";
import type { ModelInfo, ModelStreamEvent, ModelResponse } from "@sweatpan.ts/providers";
import { createTextSampling } from "../../../../../apps/yo-chat-v2/src/model.ts";
import type { ChatSamplingError, ChatLoopSample } from "@sweatpan.ts/chat";
import { createApplication } from "../../../../../apps/yo-chat-v2/src/application.ts";
import { createBrowserChat } from "../../../../../apps/yo-chat-v2/src/transport.ts";
import { Chat, ChatProvider } from "../../../../../apps/yo-chat-v2/src/ui.tsx";
import type { TextSampling } from "../../../../../apps/yo-chat-v2/src/sampling.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

const model: ModelInfo = {
  id: "scripted",
  provider: "test",
  api: "test",
  name: "Scripted",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: [],
};
const accepted: ChatLoopSample = {
  model,
  response: {
    message: { role: "assistant", content: [{ type: "text", text: "Accepted final reply" }] },
    source: null,
    usage: null,
    stopReason: "stop",
    responseId: null,
    errorMessage: null,
  },
};

forEachRuntime(<Y,>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: live chat admits once, replaces progress, reconnects and reconstructs independent readers`, async () => {
    const database = createSqliteDatabaseRig();
    const middle = createLatch<void>();
    const finish = createLatch<void>();
    let calls = 0;
    let cleaned = false;
    const sampling = createTextSampling<Y>(model, {
      stream() {
        calls++;
        return createPullStream<ModelStreamEvent, ModelResponse, Y, Y>(runtime.composition, () => {
          let step = 0;
          return function* () {
            if (step++ === 0) {
              yield* runtime.composition.ensure(function* () {
                cleaned = true;
              });
              return {
                done: false,
                value: {
                  type: "text-delta",
                  contentIndex: 1,
                  delta: "Hello",
                  partial: {
                    role: "assistant",
                    content: [
                      {
                        type: "reasoning",
                        text: "Private reasoning",
                        format: null,
                        signature: null,
                        redacted: false,
                      },
                      { type: "text", text: "Hello" },
                    ],
                  },
                },
              };
            }
            if (step === 2) {
              yield* runtime.fromPromise(() => middle.promise);
              return {
                done: false,
                value: {
                  type: "text-delta",
                  contentIndex: 0,
                  delta: " from live progress",
                  partial: {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello from live progress" }],
                  },
                },
              };
            }
            yield* runtime.fromPromise(() => finish.promise);
            return { done: true, value: accepted.response };
          };
        });
      },
    });
    const app = createApplication(runtime, database.database, { sampling });
    onTestFinished(async () => {
      middle.resolve();
      finish.resolve();
      await app.close();
      database.close();
    });
    const send: typeof fetch = (input, init) =>
      app.fetch(new Request(new URL(String(input), "http://localhost"), init));
    let connections = 0;
    let breakConnection: () => Promise<void> = async () => undefined;
    const reconnected = createLatch<void>();
    // Simulated HTTP peer duplicates invalidations and drops the first body.
    // It does not call model/execution internals.
    const unreliable: typeof fetch = async (input, init) => {
      const response = await send(input, init);
      if (!String(input).endsWith("/changes")) {
        return response;
      }
      connections++;
      if (connections === 2) {
        reconnected.resolve();
      }
      const reader = response.body!.getReader();
      if (connections === 1) {
        breakConnection = () => reader.cancel();
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const item = await reader.read();
            if (item.done) {
              controller.close();
            } else {
              controller.enqueue(item.value);
              controller.enqueue(item.value);
            }
          },
          async cancel() {
            await reader.cancel();
          },
        }),
        { headers: response.headers },
      );
    };
    const first = createBrowserChat(unreliable);
    const second = createBrowserChat(send);
    const reload = createBrowserChat(send);
    onTestFinished(async () => {
      await Promise.all([first.disconnect(), second.disconnect(), reload.disconnect()]);
      first.close();
      second.close();
      reload.close();
    });
    const ui = render(
      <StrictMode>
        <ChatProvider client={first}>
          <Chat />
          <Chat />
        </ChatProvider>
      </StrictMode>,
    );
    onTestFinished(() => ui.unmount());
    let plainNotifications = 0;
    const unsubscribe = first.subscribe(() => {
      plainNotifications++;
    });
    onTestFinished(unsubscribe);
    await act(async () => {
      first.connect();
      second.connect();
    });
    await waitFor(() => expect(first.getSnapshot().view?.status).toBe("empty"));
    const command = { command: "streamed", prompt: "Hello", after: null };
    // Receipt arrives while the sample is still waiting on its terminal gate.
    await act(async () => {
      const receipt = await first.submit(command);
      expect(receipt.execution).toBeTruthy();
    });
    await waitFor(() => expect(within(ui.container).getAllByText("Hello").length).toBe(4));
    const assistant = first.getSnapshot().view!.messages[1]!;
    expect(assistant.parts[0]).toMatchObject({ text: "Hello", state: "provisional" });
    expect(first.getSnapshot().view).toMatchObject({ active: true, status: "running" });
    expect(cleaned).toBe(false);
    const duplicate = await first.submit(command);
    expect(duplicate.duplicate).toBe(true);
    expect(calls).toBe(1);
    await act(async () => {
      await breakConnection();
      await reconnected.promise;
    });
    await waitFor(() => expect(first.getSnapshot().view!.messages).toHaveLength(2));
    expect(calls).toBe(1);
    // Removing both React consumers does not stop the shared observer or producer.
    ui.unmount();
    const notificationsBefore = plainNotifications;
    middle.resolve();
    await waitFor(() =>
      expect(
        first.getSnapshot().view?.messages[1]?.parts.find((part) => part.type === "text")?.text,
      ).toBe("Hello from live progress"),
    );
    expect(plainNotifications).toBeGreaterThan(notificationsBefore);
    await first.disconnect();
    const disconnectedView = first.getSnapshot().view;
    reload.connect();
    await waitFor(() =>
      expect(
        reload.getSnapshot().view?.messages[1]?.parts.find((part) => part.type === "text")?.text,
      ).toBe("Hello from live progress"),
    );
    expect(reload.getSnapshot().view?.messages[1]?.id).toBe(assistant.id);
    expect(cleaned).toBe(false);
    finish.resolve();
    await waitFor(() =>
      expect(second.getSnapshot().view).toMatchObject({ active: false, status: "completed" }),
    );
    await waitFor(() => expect(reload.getSnapshot().view?.status).toBe("completed"));
    expect(second.getSnapshot().view?.messages[1]).toEqual({
      ...assistant,
      parts: [{ ...assistant.parts[0], text: "Accepted final reply", state: "complete" }],
    });
    expect(first.getSnapshot().view).toBe(disconnectedView);
    first.connect();
    await waitFor(() => expect(first.getSnapshot().view).toEqual(second.getSnapshot().view));
    expect(calls).toBe(1);
    expect(cleaned).toBe(true);

    // A disconnected observer also aborts a snapshot fetch stalled in transport.
    const snapshotStarted = createLatch<void>();
    let snapshotAborted = false;
    const stalled = createBrowserChat(async (input, init) => {
      if (String(input) === "/api/conversation") {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            snapshotAborted = true;
            reject(new Error("Snapshot transport aborted"));
          };
          init?.signal?.addEventListener("abort", abort, { once: true });
          snapshotStarted.resolve();
          if (init?.signal?.aborted) {
            abort();
          }
        });
      }
      return send(input, init);
    });
    onTestFinished(() => stalled.close());
    stalled.connect();
    await snapshotStarted.promise;
    await stalled.disconnect();
    expect(snapshotAborted).toBe(true);
  });

  it(`${runtime.name}: shutdown retains provisional text without claiming completion or granting retry`, async () => {
    const database = createSqliteDatabaseRig();
    const never = createLatch<void>();
    let calls = 0;
    const sampling: TextSampling<Y> = {
      stream() {
        calls++;
        return createPullStream<string, Outcome<ChatLoopSample, ChatSamplingError>, Y, Y>(
          runtime.composition,
          () => {
            let first = true;
            return function* () {
              if (first) {
                first = false;
                return { done: false, value: "Unfinished" };
              }
              yield* runtime.fromPromise(() => never.promise);
              throw new Error("Provider lost");
            };
          },
        );
      },
    };
    let app = createApplication(runtime, database.database, { sampling });
    const client = createBrowserChat((input, init) =>
      app.fetch(new Request(new URL(String(input), "http://localhost"), init)),
    );
    onTestFinished(async () => {
      await client.disconnect();
      client.close();
      await app.close();
      database.close();
    });
    client.connect();
    const command = { command: "interrupted-stream", prompt: "Hello", after: null };
    await client.submit(command);
    await waitFor(() =>
      expect(
        client.getSnapshot().view?.messages[1]?.parts.find((part) => part.type === "text")?.text,
      ).toBe("Unfinished"),
    );
    await client.disconnect();
    await app.close();
    database.reopen();
    app = createApplication(runtime, database.database, { sampling });
    client.connect();
    await waitFor(() =>
      expect(client.getSnapshot().view).toMatchObject({ active: false, status: "running" }),
    );
    expect(client.getSnapshot().view?.messages[1]?.parts[0]).toMatchObject({
      text: "Unfinished",
      state: "provisional",
    });
    expect((await client.submit(command)).duplicate).toBe(true);
    await waitFor(async () => {
      await client.refresh();
      expect(client.getSnapshot().view?.active).toBe(false);
    });
    expect(calls).toBe(1);
  });
});
