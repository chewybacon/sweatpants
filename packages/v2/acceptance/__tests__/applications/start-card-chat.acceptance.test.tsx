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
