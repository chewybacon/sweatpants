import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, onTestFinished } from "vitest";
import type { ChatLoopRequest } from "@sweatpan.ts/chat";
import type { ModelResponse } from "@sweatpan.ts/providers";
import { FlightChat } from "../../../../../apps/yo-chat-v2/src/flights/FlightChat.tsx";
import { createDemoHandlers } from "../../../../../apps/yo-chat-v2/src/server/chat-handlers.ts";
import { defineFlightDemo } from "../../../../../apps/yo-chat-v2/src/server/flight-chat-program.ts";
import { cardDemo } from "../../../../../apps/yo-chat-v2/src/server/card-chat-program.ts";
import {
  mockFlightSearch,
  mockSeatMap,
} from "../../../../../apps/yo-chat-v2/src/server/flight-services.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  it(`${runtime.name}: flight chat reopens between pickers, rejects unavailable choices and recovers a lost ticket confirmation`, async () => {
    sessionStorage.clear();
    const directory = mkdtempSync(join(tmpdir(), "flight-chat-"));
    const connections: DatabaseSync[] = [];
    const requests: ChatLoopRequest[] = [];
    const deliveries = { search: 0, seats: 0, ticket: 0, tip: 0 };
    const demo = defineFlightDemo({
      search(from, destination) {
        deliveries.search++;
        return mockFlightSearch(from, destination);
      },
      seats() {
        deliveries.seats++;
        return mockSeatMap();
      },
      ticket() {
        deliveries.ticket++;
        return "TKT-ACCEPTANCE";
      },
    });
    const open = () => {
      const db = new DatabaseSync(join(directory, "chat.sqlite"));
      connections.push(db);
      return db;
    };
    const handlers = createDemoHandlers(demo, runtime, open, async (publish) => ({
      *sample(request) {
        requests.push(structuredClone(request));
        const result = [...request.history].reverse().find((entry) => entry.role === "tool");
        const nested = request.tools.length === 0;
        if (nested) {
          deliveries.tip++;
        }
        const text = nested
          ? "Take the airport train into the city."
          : `Your itinerary: ${result?.content}`;
        const content: ModelResponse["message"]["content"] =
          !nested && !result
            ? [
                {
                  type: "tool-call",
                  toolCall: {
                    id: "flight-call",
                    name: "book_flight",
                    input: { from: "NYC", destination: "Los Angeles" },
                    thoughtSignature: null,
                  },
                },
              ]
            : [{ type: "text", text }];
        if (nested || result) {
          publish(text);
        }
        return {
          ok: true as const,
          value: {
            model: { id: "scripted", api: "scripted", provider: "scripted" },
            response: {
              message: { role: "assistant" as const, content },
              source: null,
              usage: null,
              stopReason: null,
              responseId: null,
              errorMessage: null,
            },
          },
        };
      },
    }));
    let loseSeatConfirmation = true;
    const answerBodies: string[] = [];
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
      const command = JSON.parse(body);
      if (command.type === "answer") {
        answerBodies.push(body);
      }
      const response = await handlers.POST(context);
      if (loseSeatConfirmation && command.type === "answer" && command.value.row) {
        loseSeatConfirmation = false;
        await response.text();
        throw new Error("Lost ticket confirmation");
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
          <FlightChat fetch={send} />
        </StrictMode>,
      );
    ui = mount();
    await waitFor(() =>
      expect(ui!.getByRole("button", { name: "NYC to LA" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(ui.getByRole("button", { name: "NYC to LA" }));
    await ui.findByRole("button", { name: "Choose SH 142" });
    expect(deliveries).toEqual({ search: 1, seats: 0, ticket: 0, tip: 0 });
    const thread = JSON.parse(sessionStorage.getItem("yo-chat:flight-conversations:1")!).current;
    async function read() {
      const response = await handlers.GET({
        request: new Request(`http://localhost/api/flight-chat/${thread}`),
        params: { thread },
      });
      return (await response.text())
        .split("\n\n")
        .filter(Boolean)
        .map((event) => JSON.parse(event.slice(6)))
        .find((event) => event.type === "CUSTOM").value;
    }
    async function reject(value: unknown) {
      const view = await read();
      const question = view.turns[0].parts
        .flatMap((part: { questions?: unknown[] }) => part.questions ?? [])
        .find((question: { state: string }) => question.state === "open");
      const response = await handlers.POST({
        request: new Request(`http://localhost/api/flight-chat/${thread}`, {
          method: "POST",
          body: JSON.stringify({
            type: "answer",
            root: question.root,
            execution: question.execution,
            grant: question.grant,
            value,
          }),
        }),
        params: { thread },
      });
      expect(await response.text()).toContain("RUN_ERROR");
    }
    await reject({ flightId: "not-offered" });
    expect(deliveries.seats).toBe(0);
    fireEvent.click(ui.getByRole("button", { name: "Choose SH 142" }));
    await ui.findByRole("button", { name: "1C" });
    expect(deliveries).toEqual({ search: 1, seats: 1, ticket: 0, tip: 0 });
    const before = await read();
    const questions = before.turns[0].parts.find(
      (part: { type: string }) => part.type === "tool",
    ).questions;
    expect(questions.map((question: { state: string }) => question.state)).toEqual([
      "answered",
      "open",
    ]);
    expect(new Set(questions.map((question: { id: string }) => question.id)).size).toBe(2);
    ui.unmount();
    ui = mount();
    await ui.findByRole("button", { name: "1C" });
    expect(ui.queryByRole("button", { name: "Choose SH 142" })).toBeNull();
    expect(ui.getByText(/Flight selected: SH 142/)).toBeTruthy();
    expect(ui.getByRole("button", { name: "1A unavailable" }).hasAttribute("disabled")).toBe(true);
    expect(requests).toHaveLength(1);
    await reject({ row: 1, seat: "A" });
    expect(deliveries.ticket).toBe(0);
    fireEvent.click(ui.getByRole("button", { name: "1C" }));
    expect(deliveries.ticket).toBe(0);
    expect(ui.getByRole("button", { name: "1C" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ui.getByRole("button", { name: "Confirm seat 1C" }));
    await ui.findByRole("alert");
    expect(deliveries).toEqual({ search: 1, seats: 1, ticket: 1, tip: 1 });
    expect(ui.queryByRole("button", { name: "1D" })).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "Retry same command" }));
    await ui.findByText(/^Your itinerary:/);
    expect(answerBodies[2]).toBe(answerBodies[1]);
    expect(requests).toHaveLength(3);
    expect(deliveries).toEqual({ search: 1, seats: 1, ticket: 1, tip: 1 });
    ui.unmount();
    ui = mount();
    await ui.findByText(/Seat selected: 1C/);
    expect(ui.queryByRole("button", { name: "1C" })).toBeNull();
    expect(ui.getByText(/^Demo booking recorded/).textContent).toContain("TKT-ACCEPTANCE");
    expect(ui.getByText(/^Demo booking recorded/).textContent).toContain("airport train");
    expect(requests).toHaveLength(3);
    const after = await read();
    expect(
      after.turns[0].parts
        .find((part: { type: string }) => part.type === "tool")
        .questions.map((question: { id: string }) => question.id),
    ).toEqual(questions.map((question: { id: string }) => question.id));
    // Reusing a browser thread ID on the other demo never exposes this itinerary.
    const cards = createDemoHandlers(cardDemo, runtime, open, async () => {
      throw new Error("Read must not sample");
    });
    const other = await cards.GET({
      request: new Request(`http://localhost/api/card-chat/${thread}`),
      params: { thread },
    });
    const otherEvents = (await other.text())
      .split("\n\n")
      .filter(Boolean)
      .map((event) => JSON.parse(event.slice(6)));
    expect(otherEvents.find((event) => event.type === "CUSTOM").value.turns).toEqual([]);
    for (const db of connections) {
      expect(() => db.prepare("SELECT 1")).toThrow();
    }
  });
});
