import { StrictMode } from "react";
import { act, fireEvent, render, within, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import { createApplication } from "../../../../../apps/yo-chat-v2/src/application.ts";
import { createBrowserChat } from "../../../../../apps/yo-chat-v2/src/transport.ts";
import { Chat, ChatProvider } from "../../../../../apps/yo-chat-v2/src/ui.tsx";
import { createSqliteDatabaseRig, createLatch } from "@sweatpan.ts/testing";
import type { ChatSampling } from "@sweatpan.ts/chat";
import type { ModelInfo } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
const model: ModelInfo = {
  id: "local",
  provider: "test",
  api: "scripted",
  name: "Local",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: [],
};
forEachRuntime(<Y,>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: yo-chat-v2 submits through HTTP, recovers a lost receipt and reopens its conversation`, async () => {
    const database = createSqliteDatabaseRig();
    let calls = 0;
    const sampling: ChatSampling<Y> = {
      *sample(request) {
        calls++;
        expect(request.tools).toEqual([]);
        if (calls === 2) {
          expect(request.history.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
          ]);
          expect(request.history[1]).toMatchObject({
            content: [{ type: "text", text: "Hello from v2" }],
          });
        }
        return {
          ok: true,
          value: {
            model,
            response: {
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: calls === 1 ? "Hello from v2" : "I remember hello" },
                ],
              },
              source: {
                api: model.api,
                provider: model.provider,
                model: model.id,
                responseModel: null,
              },
              usage: null,
              stopReason: "stop",
              responseId: null,
              errorMessage: null,
            },
          },
        };
      },
    };
    let app = createApplication(runtime, database.database, { sampling });
    onTestFinished(async () => {
      await app.close();
      database.close();
    });
    let loseReceipt = true;
    const send: typeof fetch = async (input, init) => {
      const response = await app.fetch(
        new Request(new URL(String(input), "http://localhost"), init),
      );
      if (init?.method === "POST" && loseReceipt && response.ok) {
        loseReceipt = false;
        throw new Error("Connection lost after acceptance");
      }
      return response;
    };
    const client = createBrowserChat(send);
    onTestFinished(() => client.close());
    const ui = render(
      <StrictMode>
        <ChatProvider client={client}>
          <Chat />
        </ChatProvider>
      </StrictMode>,
    );
    onTestFinished(() => ui.unmount());
    const current = within(ui.container);
    await act(async () => {
      await client.refresh();
    });
    // A second mounted consumer starts from the same predecessor and keeps a draft.
    const staleClient = createBrowserChat(send);
    onTestFinished(() => staleClient.close());
    const staleUI = render(
      <ChatProvider client={staleClient}>
        <Chat />
      </ChatProvider>,
    );
    onTestFinished(() => staleUI.unmount());
    const stale = within(staleUI.container);
    await act(async () => {
      await staleClient.refresh();
    });
    fireEvent.change(stale.getByLabelText("Message"), { target: { value: "Remember?" } });
    fireEvent.change(current.getByLabelText("Message"), { target: { value: "Hello" } });
    fireEvent.click(current.getByText("Send"));
    await waitFor(() => expect(current.getByText("Hello from v2")).toBeTruthy());
    expect(current.getByRole("alert").textContent).toContain("Submission not confirmed");
    fireEvent.click(current.getByText("Retry same message"));
    await waitFor(() => expect(current.queryByRole("alert")).toBeNull());
    expect(calls).toBe(1);
    fireEvent.click(stale.getByText("Send"));
    await waitFor(() =>
      expect(stale.getByRole("alert").textContent).toContain("Message was not submitted"),
    );
    await waitFor(() =>
      expect((stale.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect((stale.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Remember?");
    expect(stale.queryByText("Retry same message")).toBeNull();
    expect(calls).toBe(1);
    const retained = client.getSnapshot().view;
    await app.close();
    database.reopen();
    app = createApplication(runtime, database.database, { sampling });
    await act(async () => {
      await client.refresh();
    });
    expect(client.getSnapshot().view).toEqual(retained);
    expect(calls).toBe(1);
    fireEvent.click(stale.getByText("Send"));
    await waitFor(() => expect(stale.getByText("I remember hello")).toBeTruthy());
    await act(async () => {
      await client.refresh();
    });
    expect(
      within(current.getByRole("region", { name: "Messages" })).getAllByRole("article"),
    ).toHaveLength(4);
    expect(calls).toBe(2);
    const rejected = await app.fetch(
      new Request("http://localhost/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "stale", prompt: "Wrong predecessor", after: null }),
      }),
    );
    expect(rejected.status).toBe(409);
    expect(calls).toBe(2);
    const foreign = await app.fetch(
      new Request("http://localhost/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://elsewhere.example" },
        body: "{}",
      }),
    );
    expect(foreign.status).toBe(403);
  });
  for (const interruption of ["provider-failure", "shutdown"] as const) {
    it(`${runtime.name}: yo-chat-v2 preserves uncertain work after ${interruption}`, async () => {
      const database = createSqliteDatabaseRig();
      let calls = 0;
      const started = createLatch<void>();
      const release = createLatch<void>();
      let cleaned = false;
      const sampling: ChatSampling<Y> = {
        *sample() {
          yield* runtime.composition.ensure(function* () {
            cleaned = true;
          });
          calls++;
          started.resolve();
          yield* runtime.fromPromise(() => release.promise);
          throw new Error("Provider connection lost");
        },
      };
      let app = createApplication(runtime, database.database, { sampling });
      onTestFinished(async () => {
        release.resolve();
        await app.close();
        database.close();
      });
      const command = { command: "uncertain", prompt: "Hello", after: null };
      const request = () =>
        new Request("http://localhost/api/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        });
      const pending = app.fetch(request());
      await started.promise;
      expect((await app.fetch(request())).status).toBe(409);
      const view = await (await app.fetch(new Request("http://localhost/api/conversation"))).json();
      expect(view.status).toBe("running");
      if (interruption === "shutdown") {
        await app.close();
        expect(cleaned).toBe(true);
        expect((await app.fetch(new Request("http://localhost/api/conversation"))).status).toBe(
          503,
        );
      } else {
        release.resolve();
      }
      expect((await pending).status).toBe(409);
      await app.close();
      expect(cleaned).toBe(true);
      database.reopen();
      app = createApplication(runtime, database.database, { sampling });
      expect((await app.fetch(request())).status).toBe(409);
      expect(calls).toBe(1);
    });
  }
});
