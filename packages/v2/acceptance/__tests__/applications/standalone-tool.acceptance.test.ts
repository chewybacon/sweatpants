import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { defineTool, projectToolContract } from "@sweatpan.ts/tools";
import { defineToolUI } from "@sweatpan.tsx/chat";
import { createStandaloneClient } from "../../../../../apps/yo-chat-v2/src/standalone/client.ts";
import { createStandaloneHandlers } from "../../../../../apps/yo-chat-v2/src/standalone/server.ts";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  it(`${runtime.name}: standalone example client retains exact answers across sequential transformed interactions`, async () => {
    const amount = defineEffect({
      key: "client/amount/1",
      context: z.string().transform((label) => ({ label })),
      response: z.string().regex(/^\d+$/).transform(Number),
    });
    const confirm = defineEffect({
      key: "client/confirm/1",
      context: z.number(),
      response: z.boolean(),
    });
    const tool = defineTool("client/sequence/1")
      .parameters(z.string())
      .elicits({ amount, confirm })
      .execute(function* (label, ctx) {
        const number = yield* ctx.elicit("amount", label);
        if (!number.ok) {
          return { amount: 0, confirmed: false };
        }
        const approved = yield* ctx.elicit("confirm", number.value);
        if (!approved.ok) {
          throw new Error("Confirmation declined");
        }
        return { amount: number.value, confirmed: approved.value };
      });
    defineToolUI(tool, {
      amount: (props) => {
        expectTypeOf(props.input).toEqualTypeOf<{ label: string }>();
        expectTypeOf(props.respond).parameter(0).toEqualTypeOf<string>();
        if (props.submitted?.ok) {
          expectTypeOf(props.submitted.value).toEqualTypeOf<string>();
        }
        if (props.outcome?.ok) {
          expectTypeOf(props.outcome.value).toEqualTypeOf<number>();
        }
        return null;
      },
      confirm: (props) => {
        expectTypeOf(props.input).toEqualTypeOf<number>();
        expectTypeOf(props.respond).parameter(0).toEqualTypeOf<boolean>();
        return null;
      },
    });
    const db = new DatabaseSync(":memory:");
    onTestFinished(() => db.close());
    let configurations = 0;
    const handlers = createStandaloneHandlers(runtime, tool, {
      name: "sequence",
      *configure() {
        configurations++;
      },
      matches: isDeepStrictEqual,
      *open(execution) {
        return createSqliteJournalStore<
          { amount: number; confirmed: boolean },
          CapabilityRequest,
          unknown,
          string
        >({
          id: execution,
          program: tool.id,
          equals: isDeepStrictEqual,
          connection: createNodeSqliteConnection(db),
          serialization: {
            *resolve() {
              return v8Serializer;
            },
          },
        }).open();
      },
    });
    const requests: { method: string; body: unknown }[] = [];
    const receipts: { receipt: string; duplicate: boolean }[] = [];
    let corrupt = true;
    let retained: string | null = null;
    const options = {
      endpoint: "/sequence",
      storage: () => ({
        getItem: () => retained,
        setItem: (_key: string, value: string) => {
          retained = value;
        },
      }),
      fetch: async (url: string, init: RequestInit) => {
        const request = new Request(new URL(url, "http://localhost"), init);
        const context = {
          request,
          params: { execution: new URL(request.url).pathname.split("/").at(-1)! },
        };
        requests.push({
          method: request.method,
          body: request.method === "GET" ? null : await request.clone().json(),
        });
        if (request.method === "GET") {
          const before = configurations;
          const response = await handlers.GET(context);
          expect(configurations).toBe(before);
          return response;
        }
        if (request.method === "POST") {
          return handlers.POST(context);
        }
        const response = await handlers.PUT(context);
        receipts.push(await response.clone().json());
        if (corrupt) {
          corrupt = false;
          return Response.json({ view: (await response.json()).view });
        }
        return response;
      },
    };
    let client = createStandaloneClient(projectToolContract(tool), options);
    onTestFinished(() => client.disconnect());
    await client.connect();
    expectTypeOf(client.start).parameter(0).toEqualTypeOf<string>();
    await client.start("Tickets");
    expect(configurations).toBeGreaterThan(0);
    const first = client.interaction("amount")!;
    expectTypeOf(first.input).toEqualTypeOf<{ label: string }>();
    expectTypeOf(first.respond).parameter(0).toEqualTypeOf<string>();
    expect(first.input).toEqual({ label: "Tickets" });
    const initial = client.presentation.getSnapshot()[0]!;
    expect(initial).toMatchObject({
      input: { label: "Tickets" },
      state: "pending",
      delivery: "idle",
      canRespond: true,
    });
    expect(client.interaction("confirm")).toBeUndefined();
    await first.respond("bad");
    expect(client.getSnapshot().pending).toBe(false);
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    const deliveries: string[] = [];
    const unsubscribe = client.presentation.subscribe(() => {
      const question = client.presentation.getSnapshot()[0];
      if (question) {
        deliveries.push(question.delivery);
      }
    });
    await first.respond("12");
    unsubscribe();
    expect(deliveries).toContain("sending");
    expect(client.getSnapshot()).toMatchObject({ pending: true, error: "Invalid answer receipt" });
    expect(client.interaction("amount")).toBeUndefined();
    expect(client.presentation.getSnapshot()[0]).toMatchObject({
      id: initial.id,
      state: "pending",
      delivery: "unconfirmed",
      canRespond: false,
      submitted: { ok: true, value: "12" },
    });
    client.disconnect();
    client = createStandaloneClient(projectToolContract(tool), options);
    const refreshedDeliveries: string[] = [];
    const stopObserving = client.presentation.subscribe(() => {
      const question = client.presentation.getSnapshot()[0];
      if (question) {
        refreshedDeliveries.push(question.delivery);
      }
    });
    await client.connect(); // observes second question, but does not lose the uncertain first answer
    stopObserving();
    expect(refreshedDeliveries).not.toContain("sending");
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(client.getSnapshot().pending).toBe(true);
    expect(client.interaction("confirm")).toBeUndefined();
    expect(client.presentation.getSnapshot()[0]).toMatchObject({
      id: initial.id,
      state: "answered",
      delivery: "unconfirmed",
      canRespond: false,
      submitted: { ok: true, value: "12" },
      outcome: { ok: true, value: 12 },
    });
    expect(client.presentation.getSnapshot()[1]).toMatchObject({
      state: "pending",
      delivery: "idle",
      canRespond: false,
      input: 12,
    });
    expect(client.presentation.getSnapshot()[1]!.submitted).toBeUndefined();
    await client.retry();
    expect(requests.filter((r) => r.method === "PUT")[1]).toEqual(
      requests.filter((r) => r.method === "PUT")[0],
    );
    expect(receipts.map((receipt) => receipt.duplicate)).toEqual([false, true]);
    expect(receipts[0].receipt).toBe(receipts[1].receipt);
    const second = client.interaction("confirm")!;
    expectTypeOf(second.respond).parameter(0).toEqualTypeOf<boolean>();
    expect(second.input).toBe(12);
    // An old callback belongs to its disconnected receiver, not the replacement client.
    await first.respond("13");
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2);
    await second.respond(true);
    expect(client.getSnapshot()).toMatchObject({
      pending: false,
      view: { status: "completed", value: { amount: 12, confirmed: true } },
    });
    await second.respond(false);
    expect(client.getSnapshot().error).toBeUndefined();
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(3);
    // A supported decline is an accepted domain outcome, not a delivery failure.
    await client.start("No tickets");
    const declined = client.presentation.getSnapshot()[0]!;
    expect(declined.decline).toBeDefined();
    await declined.decline!({ reason: "no-tickets" });
    expect(client.presentation.getSnapshot()[0]).toMatchObject({
      state: "answered",
      delivery: "idle",
      canRespond: false,
      outcome: { ok: false, error: { reason: "no-tickets" } },
    });
    expect(client.getSnapshot().view).toMatchObject({
      status: "completed",
      value: { amount: 0, confirmed: false },
    });
    const beforeStaleDecline = requests.length;
    await declined.decline!({ reason: "changed-mind" });
    expect(requests).toHaveLength(beforeStaleDecline);
    expect(client.getSnapshot().error).toBeUndefined();
  });
});
