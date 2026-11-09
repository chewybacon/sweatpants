import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { createStandaloneClient } from "../../../../../apps/yo-chat-v2/src/standalone/client.ts";
import { ToolUIProvider, ToolOutlet, type ToolUIProps } from "@sweatpan.tsx/chat";
import { pickCard } from "../../../../../apps/yo-chat-v2/src/tools/pick-card.ts";
import { CardPicker } from "../../../../../apps/yo-chat-v2/src/cards/CardPicker.tsx";
import { cardUI } from "../../../../../apps/yo-chat-v2/src/cards/card-ui.tsx";
import { createStandaloneHandlers } from "../../../../../apps/yo-chat-v2/src/standalone/server.ts";
import { cardApplicationOptions } from "../../../../../apps/yo-chat-v2/src/server/pick-card.ts";
import type { PlayingCard } from "../../../../../apps/yo-chat-v2/src/cards/contracts.ts";
import { drawCards, chooseCard } from "../../../../../apps/yo-chat-v2/src/tools/pick-card.ts";
import type { Runtime } from "@sweatpan.ts/runtime";

// Deterministic external deck capability, installed through the same public host boundary.
function createCardHandlers<Y>(runtime: Runtime<Y>, open: () => DatabaseSync) {
  return createStandaloneHandlers(runtime, pickCard, {
    ...cardApplicationOptions(runtime, open),
    *configure({ effects }) {
      yield* effects.install(drawCards, function* (count) {
        return {
          ok: true,
          value: [
            { rank: "A", suit: "spades", display: "A♠" },
            { rank: "Q", suit: "hearts", display: "Q♥" },
            { rank: "7", suit: "clubs", display: "7♣" },
          ].slice(0, count),
        };
      });
    },
  });
}
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  for (const lost of ["none", "before-acceptance", "after-acceptance"] as const) {
    it(`${runtime.name}: card picker reloads and recovers ${lost} without changing its command`, async () => {
      window.sessionStorage.clear();
      const directory = mkdtempSync(join(tmpdir(), "card-ui-"));
      const path = join(directory, "cards.sqlite");
      const dbs: DatabaseSync[] = [];
      const handlers = createCardHandlers(runtime, () => {
        const db = new DatabaseSync(path);
        dbs.push(db);
        return db;
      });
      const starts: string[] = [];
      const answers: { execution: string; body: unknown }[] = [];
      const receipts: { receipt: string; duplicate: boolean }[] = [];
      let lose = lost !== "none";
      let view: ReturnType<typeof render> | undefined;
      onTestFinished(() => {
        view?.unmount();
        window.sessionStorage.clear();
        rmSync(directory, { recursive: true, force: true });
      });
      const send = async (url: string, init: RequestInit) => {
        const request = new Request(new URL(url, "http://localhost"), init);
        const execution = new URL(request.url).pathname.split("/").at(-1)!;
        const context = { request, params: { execution } };
        if (request.method === "GET") {
          return handlers.GET(context);
        }
        if (request.method === "POST") {
          starts.push(execution);
          return handlers.POST(context);
        }
        answers.push({ execution, body: await request.clone().json() });
        if (lose && lost === "before-acceptance") {
          lose = false;
          throw new Error("Connection lost");
        }
        const response = await handlers.PUT(context);
        receipts.push(await response.clone().json());
        if (lose) {
          lose = false;
          throw new Error("Receipt lost");
        }
        return response;
      };
      const mount = () =>
        render(
          <StrictMode>
            <CardPicker fetch={send} />
          </StrictMode>,
        );
      view = mount();
      fireEvent.click(await view.findByRole("button", { name: "Start picking" }));
      await view.findByRole("button", { name: "Q♥" });
      expect(starts).toHaveLength(1);
      // A full component remount reuses browser storage and reads the persisted question.
      view.unmount();
      view = mount();
      fireEvent.click(await view.findByRole("button", { name: "Q♥" }));
      if (lost !== "none") {
        await view.findByRole("alert");
        expect(view.getByRole("button", { name: "A♠" }).hasAttribute("disabled")).toBe(true);
        fireEvent.click(view.getByRole("button", { name: "Retry same answer" }));
      }
      await view.findByText("You picked Q♥.");
      expect(starts).toHaveLength(1);
      expect(answers).toHaveLength(lost === "none" ? 1 : 2);
      expect(answers.every((answer) => answer.execution === starts[0])).toBe(true);
      if (lost !== "none") {
        expect(answers[1]).toEqual(answers[0]);
      }
      if (lost === "after-acceptance") {
        expect(receipts.map((receipt) => receipt.duplicate)).toEqual([false, true]);
        expect(receipts[0].receipt).toBe(receipts[1].receipt);
      }
      view.unmount();
      view = mount();
      await view.findByText("You picked Q♥.");
      expect(view.getByRole("button", { name: "Q♥" }).hasAttribute("disabled")).toBe(true);
      expect(view.getByText("You picked: Q♥")).toBeTruthy();
      expect(answers).toHaveLength(lost === "none" ? 1 : 2);
      fireEvent.click(view.getByRole("button", { name: "Pick another card" }));
      await view.findByRole("button", { name: "A♠" });
      expect(starts).toHaveLength(2);
      expect(starts[1]).not.toBe(starts[0]);
      for (const db of dbs) {
        expect(() => db.prepare("SELECT 1")).toThrow();
      }
    });
  }

  it(`${runtime.name}: reload retains an uncertain answer and unmount ignores a late response`, async () => {
    window.sessionStorage.clear();
    const directory = mkdtempSync(join(tmpdir(), "card-ui-pending-"));
    const path = join(directory, "cards.sqlite");
    const handlers = createCardHandlers(runtime, () => new DatabaseSync(path));
    let lose = true;
    let loseStart = true;
    const starts: string[] = [];
    const sent: unknown[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    let view: ReturnType<typeof render> | undefined;
    onTestFinished(() => {
      release?.();
      view?.unmount();
      window.sessionStorage.clear();
      rmSync(directory, { recursive: true, force: true });
    });
    const send = async (url: string, init: RequestInit) => {
      const request = new Request(new URL(url, "http://localhost"), init);
      const execution = new URL(request.url).pathname.split("/").at(-1)!;
      const context = { request, params: { execution } };
      if (request.method === "POST") {
        starts.push(execution);
        const response = await handlers.POST(context);
        if (loseStart) {
          loseStart = false;
          throw new Error("Start response lost");
        }
        return response;
      }
      if (request.method === "GET") {
        return handlers.GET(context);
      }
      sent.push(await request.clone().json());
      if (lose) {
        lose = false;
        throw new Error("Offline before delivery");
      }
      const response = await handlers.PUT(context);
      if (hold) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response; // deliberately ignores abort to test late-response ownership
    };
    view = render(<CardPicker fetch={send} />);
    fireEvent.click(await view.findByRole("button", { name: "Start picking" }));
    await view.findByRole("alert");
    fireEvent.click(view.getByRole("button", { name: "Retry start" }));
    fireEvent.click(await view.findByRole("button", { name: "7♣" }));
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBe(starts[0]);
    await view.findByRole("alert");
    view.unmount();
    view = render(<CardPicker fetch={send} />);
    await waitFor(() =>
      expect(
        view!.getByRole("button", { name: "Retry same answer" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(view.getByRole("button", { name: "A♠" }).hasAttribute("disabled")).toBe(true);
    hold = true;
    fireEvent.click(view.getByRole("button", { name: "Retry same answer" }));
    await waitFor(() => expect(release).toBeDefined());
    view.unmount();
    view = render(<CardPicker fetch={send} />);
    await view.findByText("You picked 7♣.");
    fireEvent.click(view.getByRole("button", { name: "Pick another card" }));
    await view.findByRole("button", { name: "A♠" });
    const retained = window.sessionStorage.getItem("yo-chat:pick-card:v3");
    await act(async () => {
      release!();
    });
    expect(window.sessionStorage.getItem("yo-chat:pick-card:v3")).toBe(retained);
    expect(sent[1]).toEqual(sent[0]);
    expect(view.queryByText("You picked 7♣.")).toBeNull();
  });
});

forEachRuntime((runtime) => {
  it(`${runtime.name}: one registered plugin moves between a message node and sidebar without owning delivery`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "card-outlet-"));
    const handlers = createCardHandlers(
      runtime,
      () => new DatabaseSync(join(directory, "cards.sqlite")),
    );
    let writes = 0;
    const client = createStandaloneClient(pickCard, {
      endpoint: "/cards",
      fetch: async (url, init) => {
        const request = new Request(new URL(url, "http://localhost"), init);
        const context = {
          request,
          params: { execution: new URL(request.url).pathname.split("/").at(-1)! },
        };
        if (request.method === "POST") {
          return handlers.POST(context);
        }
        if (request.method === "PUT") {
          writes++;
          return handlers.PUT(context);
        }
        return handlers.GET(context);
      },
    });
    let ui: ReturnType<typeof render> | undefined;
    onTestFinished(() => {
      ui?.unmount();
      client.disconnect();
      rmSync(directory, { recursive: true, force: true });
    });
    await client.connect();
    await client.start({});
    expect(cardUI.program).toBe(pickCard.id);
    expectTypeOf<ToolUIProps<typeof chooseCard>["respond"]>()
      .parameter(0)
      .toEqualTypeOf<PlayingCard>();
    const question = client.presentation.getSnapshot()[0]!;
    const layout = (placement: string) => (
      <StrictMode>
        <ToolUIProvider source={client.presentation} plugins={[cardUI]} placement={() => placement}>
          <section aria-label="Message tree">
            <article>
              <ToolOutlet question={question.id} />
            </article>
          </section>
          <aside aria-label="Sidebar">
            <ToolOutlet placement="sidebar" />
          </aside>
        </ToolUIProvider>
      </StrictMode>
    );
    ui = render(layout("inline"));
    expect(
      within(ui.getByRole("region", { name: "Message tree" })).getByRole("button", {
        name: "Q♥",
      }),
    ).toBeTruthy();
    expect(within(ui.getByRole("complementary")).queryByRole("button")).toBeNull();
    ui.rerender(layout("sidebar"));
    expect(
      within(ui.getByRole("region", { name: "Message tree" })).queryByRole("button"),
    ).toBeNull();
    expect(writes).toBe(0);
    ui.unmount();
    expect(client.presentation.getSnapshot()[0]!.canRespond).toBe(true);
    ui = render(layout("sidebar"));
    fireEvent.click(within(ui.getByRole("complementary")).getByRole("button", { name: "Q♥" }));
    await ui.findByText("You picked: Q♥");
    await waitFor(() => expect(client.presentation.getSnapshot()[0]!.state).toBe("answered"));
    expect(client.presentation.getSnapshot()[0]!.id).toBe(question.id);
    ui.rerender(layout("inline"));
    expect(
      within(ui.getByRole("region", { name: "Message tree" }))
        .getByRole("button", { name: "Q♥" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      await question.respond({ rank: "A", suit: "spades", display: "A♠" });
    });
    expect(writes).toBe(1);
    expect(client.getSnapshot().error).toBeUndefined();
    const completed = client.getSnapshot().view;
    expect(completed?.status).toBe("completed");
    if (completed?.status === "completed") {
      expectTypeOf(completed.value.card).toEqualTypeOf<PlayingCard>();
      expect(completed.value.card).toEqual({ rank: "Q", suit: "hearts", display: "Q♥" });
      const answered = client.presentation.getSnapshot()[0]!;
      const snapshot = [
        answered,
        { ...answered, id: "unknown-effect", effect: "future/effect" },
        { ...answered, id: "unknown-program", program: "future/program" },
      ];
      const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
      ui.rerender(
        <ToolUIProvider source={source} plugins={[cardUI]}>
          <ToolOutlet />
        </ToolUIProvider>,
      );
      expect(ui.getByText("You picked: Q♥")).toBeTruthy();
      expect(ui.getByText("No UI registered for future/program").getAttribute("role")).toBe(
        "status",
      );
      expect(ui.getByText(`No UI registered for ${pickCard.id}/future/effect`)).toBeTruthy();
    }
  });
});
