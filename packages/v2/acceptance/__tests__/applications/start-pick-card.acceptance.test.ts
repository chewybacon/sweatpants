import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { forEachRuntime } from "../runtime/assembly.ts";
import { createCardHandlers } from "../../../../../apps/yo-chat-v2/src/server/card-handlers.ts";

forEachRuntime((runtime) => {
  it(`${runtime.name}: Start handlers retain pick_card across connections and acknowledge identical retries`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "start-pick-card-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "cards.sqlite");
    const connections: DatabaseSync[] = [];
    const open = () => {
      const db = new DatabaseSync(path);
      connections.push(db);
      return db;
    };
    let handlers = createCardHandlers(runtime, open);
    const execution = crypto.randomUUID();
    const context = (method: string, body?: unknown, id: string = execution, origin?: string) => {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (origin) {
        headers.set("Origin", origin);
      }
      return {
        params: { execution: id },
        request: new Request(`http://localhost/api/cards/${id}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      };
    };

    expect((await handlers.GET(context("GET"))).status).toBe(404);
    expect((await handlers.PUT(context("PUT", { card: "invalid" }))).status).toBe(400);
    expect(
      (await handlers.POST(context("POST", undefined, execution, "https://foreign.example")))
        .status,
    ).toBe(403);
    expect((await handlers.GET(context("GET", undefined, "bad/id"))).status).toBe(400);
    expect((await handlers.GET(context("GET"))).status).toBe(404);

    const started = await handlers.POST(context("POST", { input: {} }));
    expect(started.status).toBe(200);
    const waiting = await started.json();
    expect(waiting).toMatchObject({
      execution,
      status: "waiting",
      question: { input: { prompt: "Pick one of these 3 cards:" } },
    });
    expect(waiting.question.input.cards).toHaveLength(3);
    expect(
      new Set(waiting.question.input.cards.map((card: { display: string }) => card.display)).size,
    ).toBe(3);
    const [otherCard, selectedCard] = waiting.question.input.cards;

    // No retained host or database survives a request. Reconstruct from the file.
    handlers = createCardHandlers(runtime, open);
    expect(await (await handlers.GET(context("GET"))).json()).toEqual(waiting);
    expect(await (await handlers.POST(context("POST", { input: {} }))).json()).toEqual(waiting);

    // Invalid values and another execution's grant cannot change this question.
    await expect(
      handlers.PUT(
        context("PUT", { grant: waiting.question.grant, outcome: { ok: true, value: "joker" } }),
      ),
    ).rejects.toThrow();
    const foreignId = crypto.randomUUID();
    const foreign = await (await handlers.POST(context("POST", { input: {} }, foreignId))).json();
    await expect(
      handlers.PUT(
        context("PUT", {
          grant: foreign.question.grant,
          outcome: { ok: true, value: otherCard },
        }),
      ),
    ).rejects.toThrow();
    expect(await (await handlers.GET(context("GET"))).json()).toEqual(waiting);

    const command = {
      grant: waiting.question.grant,
      outcome: { ok: true, value: selectedCard },
    };
    const concurrent = await Promise.all([
      handlers.PUT(context("PUT", command)).then((response) => response.json()),
      handlers.PUT(context("PUT", command)).then((response) => response.json()),
    ]);
    expect(concurrent.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(concurrent[0].receipt).toBe(concurrent[1].receipt);
    const answered = concurrent.find((result) => !result.duplicate)!;
    expect(answered).toMatchObject({
      duplicate: false,
      view: { execution, status: "completed", value: { card: selectedCard } },
    });
    handlers = createCardHandlers(runtime, open);
    const retried = await (await handlers.PUT(context("PUT", command))).json();
    expect(retried).toEqual({ ...answered, duplicate: true });
    await expect(
      handlers.PUT(context("PUT", { ...command, outcome: { ok: true, value: otherCard } })),
    ).rejects.toThrow();
    expect(await (await handlers.GET(context("GET"))).json()).toEqual(answered.view);
    expect(await (await handlers.POST(context("POST", { input: {} }))).json()).toEqual(
      answered.view,
    );
    expect(await (await handlers.GET(context("GET", undefined, foreignId))).json()).toEqual(
      foreign,
    );

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      handlers.POST({
        params: { execution: crypto.randomUUID() },
        request: new Request("http://localhost/api/cards/aborted", {
          method: "POST",
          signal: cancelled.signal,
          body: JSON.stringify({ input: {} }),
        }),
      }),
    ).rejects.toThrow();

    for (const db of connections) {
      expect(() => db.prepare("SELECT 1")).toThrow();
    }
  });
});
