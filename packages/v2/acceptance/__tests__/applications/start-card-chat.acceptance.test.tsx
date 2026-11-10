import { createReadableStream } from "@sweatpan.ts/runtime";
import {
  createCardChatRun,
  type CardRunEvent,
} from "../../../../../apps/yo-chat-v2/src/server/card-chat-run.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, onTestFinished } from "vitest";
import type { ChatLoopRequest, ChatSampling } from "@sweatpan.ts/chat";
import type { ModelResponse } from "@sweatpan.ts/providers";
import { CardChat } from "../../../../../apps/yo-chat-v2/src/card-chat/CardChat.tsx";
import { createCardChatHandlers } from "../../../../../apps/yo-chat-v2/src/server/card-chat-handlers.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  it(`${runtime.name}: model card chat resumes its picker, confirms a lost answer and remembers the selection`, async () => {
    sessionStorage.clear();
    const directory = mkdtempSync(join(tmpdir(), "card-chat-"));
    const requests: ChatLoopRequest[] = [];
    const connections: DatabaseSync[] = [];
    const handlers = createCardChatHandlers(
      runtime,
      () => {
        const db = new DatabaseSync(join(directory, "chat.sqlite"));
        connections.push(db);
        return db;
      },
      async (publish) =>
        ({
          *sample(request) {
            requests.push(structuredClone(request));
            const userCount = request.history.filter((entry) => entry.role === "user").length;
            const result = [...request.history].reverse().find((entry) => entry.role === "tool");
            const text =
              userCount > 1 ? `I remember: ${result?.content}` : `You chose: ${result?.content}`;
            const content: ModelResponse["message"]["content"] = !result
              ? [
                  {
                    type: "tool-call",
                    toolCall: {
                      id: "card-call",
                      name: "pick_card",
                      input: { count: 3 },
                      thoughtSignature: null,
                    },
                  },
                ]
              : [{ type: "text", text }];
            if (result) {
              publish(text.slice(0, 12));
              publish(text);
            }
            return {
              ok: true,
              value: {
                model: { id: "scripted", api: "scripted", provider: "scripted" },
                response: {
                  message: { role: "assistant", content },
                  source: null,
                  usage: null,
                  stopReason: null,
                  responseId: null,
                  errorMessage: null,
                },
              },
            };
          },
        }) satisfies ChatSampling<never>,
    );
    let lose = true;
    const bodies: string[] = [];
    const send: typeof fetch = async (url, init) => {
      const request = new Request(new URL(String(url), "http://localhost"), init);
      const context = {
        request,
        params: { thread: new URL(request.url).pathname.split("/").at(-1)! },
      };
      if (request.method === "GET") {
        return handlers.GET(context);
      }
      const body = await request.clone().text();
      bodies.push(body);
      const response = await handlers.POST(context);
      if (lose && JSON.parse(body).type === "answer") {
        lose = false;
        await response.text();
        throw new Error("Lost answer confirmation");
      }
      return response;
    };
    let ui: ReturnType<typeof render> | undefined;
    onTestFinished(() => {
      ui?.unmount();
      sessionStorage.clear();
      rmSync(directory, { recursive: true, force: true });
    });
    const mount = () =>
      render(
        <StrictMode>
          <CardChat fetch={send} />
        </StrictMode>,
      );
    ui = mount();
    await waitFor(() =>
      expect(ui!.getByRole("button", { name: "Pick a card" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(ui.getByRole("button", { name: "Pick a card" }));
    await ui.findByText("Pick one of these 3 cards:");
    const cards = ui
      .getAllByRole("button")
      .map((button) => button.textContent!)
      .filter((label) => /[♠♥♦♣]/.test(label));
    expect(cards).toHaveLength(3);
    expect(new Set(cards).size).toBe(3);
    expect(requests).toHaveLength(1);
    const retained = JSON.parse(sessionStorage.getItem("yo-chat:card-conversations:2")!);
    const read = await handlers.GET({
      request: new Request(`http://localhost/api/card-chat/${retained.current}`),
      params: { thread: retained.current },
    });
    const events = (await read.text())
      .split("\n\n")
      .filter((event) => event.startsWith("data: "))
      .map((event) => JSON.parse(event.slice(6)));
    const observed = events.find((event) => event.type === "CUSTOM").value;
    const question = observed.turns[0].parts.find((part: { type: string }) => part.type === "tool")
      .questions[0];
    const rejected = await handlers.POST({
      request: new Request(`http://localhost/api/card-chat/${retained.current}`, {
        method: "POST",
        body: JSON.stringify({
          type: "answer",
          root: question.root,
          execution: question.execution,
          grant: question.grant,
          value: { rank: "Joker", suit: "none", display: "Joker" },
        }),
      }),
      params: { thread: retained.current },
    });
    expect(await rejected.text()).toContain("RUN_ERROR");
    expect(requests).toHaveLength(1);
    ui.unmount();
    ui = mount();
    await ui.findByRole("button", { name: cards[0] });
    expect(requests).toHaveLength(1);
    fireEvent.click(ui.getByRole("button", { name: cards[0] }));
    await ui.findByRole("alert");
    expect(ui.getByRole("button", { name: cards[1] }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(ui.getByRole("button", { name: "Retry same command" }));
    await ui.findByText(/^You chose:/);
    expect(bodies[2]).toBe(bodies[1]);
    expect(requests).toHaveLength(2);
    ui.unmount();
    ui = mount();
    await ui.findByText(`You picked: ${cards[0]}`);
    expect(ui.getByRole("button", { name: cards[0] }).hasAttribute("disabled")).toBe(true);
    const composer = ui.getByRole("textbox");
    fireEvent.input(composer, { target: { textContent: "Which card did I pick?" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await ui.findByText(/^I remember:/);
    expect(ui.getByText(/^I remember:/).textContent).toContain(cards[0]);
    expect(requests).toHaveLength(3);
    fireEvent.click(ui.getByRole("button", { name: "New conversation" }));
    await ui.findByText("What will you draw?");
    expect(ui.queryByText(`You picked: ${cards[0]}`)).toBeNull();
    await waitFor(() =>
      expect(ui!.getByRole("button", { name: "Pick a card for me" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(ui.getByRole("button", { name: "Pick a card for me" }));
    await ui.findByText(`You picked: ${cards[0]}`);
    expect(requests).toHaveLength(3);
    for (const db of connections) {
      expect(() => db.prepare("SELECT 1")).toThrow();
    }
  });
});

forEachRuntime((runtime) => {
  it(`${runtime.name}: run readers pull independently, reconnect by offset, and never own production`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "card-run-"));
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const connections: DatabaseSync[] = [];
    const open = () => {
      const db = new DatabaseSync(join(directory, "chat.sqlite"));
      connections.push(db);
      return db;
    };
    const run = createCardChatRun(
      runtime,
      open,
      async (publish) => ({
        *sample() {
          calls++;
          publish("Hello");
          yield* runtime.fromPromise(() => ready);
          publish("Hello world");
          return {
            ok: true as const,
            value: {
              model: { id: "scripted", api: "scripted", provider: "scripted" },
              response: {
                message: {
                  role: "assistant" as const,
                  content: [{ type: "text" as const, text: "Hello world" }],
                },
                source: null,
                usage: null,
                stopReason: null,
                responseId: null,
                errorMessage: null,
              },
            },
          };
        },
      }),
      "stream-test",
      { type: "message", command: crypto.randomUUID(), prompt: "Hello", after: null },
    );
    const first = createReadableStream(runtime, run.events()).getReader();
    const second = createReadableStream(runtime, run.events()).getReader();
    expect(calls).toBe(0);
    const owner = runtime.start(() => run.run());
    onTestFinished(async () => {
      release();
      await first.cancel();
      await second.cancel();
      await owner.cancel();
      rmSync(directory, { recursive: true, force: true });
    });
    const prefix: CardRunEvent[] = [];
    for (let index = 0; index < 3; index++) {
      const a = await first.read();
      const b = await second.read();
      expect(a).toEqual(b);
      expect(a.done).toBe(false);
      prefix.push(a.value!);
    }
    expect(prefix.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
    ]);
    await first.cancel();
    // This offset belongs to this retained attempt only, not to the journal.
    const resumed = createReadableStream(runtime, run.events(prefix.length)).getReader();
    onTestFinished(() => resumed.cancel());
    const pending = resumed.read();
    release();
    expect((await pending).value).toEqual({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: (prefix[2] as { messageId: string }).messageId,
      delta: " world",
    });
    const suffix: CardRunEvent[] = [];
    while (true) {
      const item = await resumed.read();
      if (item.done) {
        break;
      }
      suffix.push(item.value);
    }
    expect(suffix.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_END",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
    const view = await owner.result;
    expect(view.turns[0]?.status).toBe("completed");
    expect(calls).toBe(1);
    // A slow reader sees all retained events even after production has completed.
    const slow: CardRunEvent[] = [];
    while (true) {
      const item = await second.read();
      if (item.done) {
        break;
      }
      slow.push(item.value);
    }
    expect(slow.slice(1)).toEqual(suffix);
    // A fresh request reconstructs accepted history without replaying transient deltas.
    const reopened = createCardChatRun(
      runtime,
      open,
      async () => {
        throw new Error("Read cannot resolve provider");
      },
      "stream-test",
    );
    const replay = createReadableStream(runtime, reopened.events()).getReader();
    const readOwner = runtime.start(() => reopened.run());
    const restored: CardRunEvent[] = [];
    while (true) {
      const item = await replay.read();
      if (item.done) {
        break;
      }
      restored.push(item.value);
    }
    await readOwner.result;
    expect(restored.map((event) => event.type)).toEqual(["RUN_STARTED", "CUSTOM", "RUN_FINISHED"]);
    expect(restored.find((event) => event.type === "CUSTOM")).toMatchObject({ value: view });
    for (const db of connections) {
      expect(() => db.prepare("SELECT 1")).toThrow();
    }
  });

  it(`${runtime.name}: an aborted request closes the stream even before production begins`, async () => {
    const handlers = createCardChatHandlers(
      runtime,
      () => {
        throw new Error("Must not open");
      },
      async () => {
        throw new Error("Must not sample");
      },
    );
    const signal = AbortSignal.abort(new Error("Disconnected"));
    const response = await handlers.GET({
      request: new Request("http://localhost/api/card-chat/aborted", { signal }),
      params: { thread: "aborted" },
    });
    expect(await response.text()).toBe("");
  });
});

forEachRuntime((runtime) => {
  it(`${runtime.name}: the HTTP owner joins interruption without logically cancelling the turn`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "card-request-owner-"));
    const connections: DatabaseSync[] = [];
    let latePublish: ((text: string) => void) | undefined;
    const handlers = createCardChatHandlers(
      runtime,
      () => {
        const db = new DatabaseSync(join(directory, "chat.sqlite"));
        connections.push(db);
        return db;
      },
      async (publish) => {
        latePublish = publish;
        return {
          *sample() {
            publish("Working");
            return yield* runtime.fromPromise<never>(
              (signal) =>
                new Promise((_, reject) => {
                  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  if (signal.aborted) {
                    reject(signal.reason);
                  }
                }),
            );
          },
        };
      },
    );
    const response = await handlers.POST({
      request: new Request("http://localhost/api/card-chat/interruption", {
        method: "POST",
        body: JSON.stringify({
          type: "message",
          command: crypto.randomUUID(),
          prompt: "Hello",
          after: null,
        }),
      }),
      params: { thread: "interruption" },
    });
    // Neither an unconsumed response nor its construction owns active work yet.
    expect(connections).toHaveLength(0);
    const reader = response.body!.getReader();
    onTestFinished(async () => {
      await reader.cancel();
      rmSync(directory, { recursive: true, force: true });
    });
    const decoder = new TextDecoder();
    while (true) {
      const item = await reader.read();
      expect(item.done).toBe(false);
      if (decoder.decode(item.value).includes("TEXT_MESSAGE_CONTENT")) {
        break;
      }
    }
    await reader.cancel();
    expect(connections.length).toBeGreaterThan(0);
    for (const db of connections) {
      expect(() => db.prepare("SELECT 1")).toThrow();
    }
    expect(() => latePublish?.("Late provider callback")).not.toThrow();
    const reopened = await handlers.GET({
      request: new Request("http://localhost/api/card-chat/interruption"),
      params: { thread: "interruption" },
    });
    const events = (await reopened.text())
      .split("\n\n")
      .filter(Boolean)
      .map((event) => JSON.parse(event.slice(6)));
    const view = events.find((event) => event.type === "CUSTOM").value;
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].status).toBe("running");
  });
});
