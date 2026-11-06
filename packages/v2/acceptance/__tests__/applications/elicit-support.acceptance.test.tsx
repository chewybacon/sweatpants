import { act, fireEvent, render, within } from "@testing-library/react";
import { isValidElement } from "react";
import {
  createReactElicitHost,
  ElicitViews,
  SeatPicker,
} from "../../../../../apps/yo-chat-v2/src/react-elicit.tsx";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Work } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatLoopResult } from "@sweatpan.ts/chat";
import { createChatToolBinding, defineChatProgram } from "@sweatpan.ts/chat-host";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createHostedRecovery, createSqliteJournalRig } from "@sweatpan.ts/testing";
import {
  installSelectedElicitHandlers,
  createElicitResponder,
  type ToolInteraction,
} from "@sweatpan.ts/tools";
import {
  chooseFlight,
  flightResult,
  searchFlights,
  travelTip,
} from "../../examples/flight-chat.ts";
import { defineElicitPlugin, defineElicitPlugins, selectToolSupport } from "@sweatpan.ts/tools";
import { selectionSchema } from "../../../../../apps/yo-chat-v2/src/elicit-support.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

const sharedDeclaration = defineElicitPlugins<{ choice: "flight-1" | "flight-2" }>()(
  chooseFlight,
).onElicit({
  *pickFlight(_args, ctx) {
    return { ok: true, value: ctx.choice };
  },
});

const supportedFlightChat = defineChatProgram({
  id: "supported-flight-chat-v1",
  history(input) {
    return [{ role: "user", content: z.object({ prompt: z.string() }).parse(input).prompt }];
  },
  toolResult(value) {
    return { content: JSON.stringify(flightResult.parse(value)), isError: false };
  },
  result(completed) {
    return completed;
  },
});

forEachRuntime(<Y,>(runtime: Runtime<Y>) => {
  for (const serverSeat of [false, true]) {
    it(`${runtime.name}: admitted elicit support survives frontend replacement (server seat: ${serverSeat})`, async () => {
      let handledFlights = 0;
      let handledSeats = 0;
      let serverSeats = 0;
      function createFrontend() {
        const host = createReactElicitHost(runtime);
        const plugin = host.definePlugin(chooseFlight).onElicit({
          *pickFlight({ context: flights }) {
            expectTypeOf(flights).toEqualTypeOf<{ id: string; airline: string }[]>();
            handledFlights++;
            return { ok: true, value: "flight-1" };
          },
          *pickSeat(args, ctx) {
            expectTypeOf(args.context).toEqualTypeOf<{ flight: string; seats: string[] }>();
            expectTypeOf(ctx.interaction.key).toEqualTypeOf<"pickSeat">();
            expect(Object.isFrozen(ctx)).toBe(true);
            expect(Object.isFrozen(ctx.interaction)).toBe(true);
            expect(args.context.flight).toBe("flight-1");
            handledSeats++;
            const value = yield* ctx.render(SeatPicker, args.context);
            expectTypeOf(value).toEqualTypeOf<"2A" | "2B">();
            return { ok: true, value };
          },
        });
        return { host, plugin, responder: host.bindPlugin(plugin) };
      }
      let session = createFrontend();
      let ui = render(<ElicitViews host={session.host} />);
      onTestFinished(() => ui.unmount());
      const partial = defineElicitPlugin(chooseFlight).onElicit({
        *pickFlight() {
          return { ok: true, value: "flight-1" };
        },
      });
      // Requests identify effects, so these two aliases cannot be routed separately.
      const collidingTools = [
        {
          ...chooseFlight,
          elicits: {
            pickSeat: chooseFlight.elicits.pickSeat,
            pickFlight: chooseFlight.elicits.pickFlight,
            duplicate: chooseFlight.elicits.pickFlight,
          },
        },
        {
          ...chooseFlight,
          elicits: {
            pickSeat: chooseFlight.elicits.pickSeat,
            duplicate: chooseFlight.elicits.pickFlight,
            pickFlight: chooseFlight.elicits.pickFlight,
          },
        },
      ];
      for (const tool of collidingTools) {
        expect(() => defineElicitPlugin(tool)).toThrow("Duplicate elicit effect ID");
        expect(() =>
          selectToolSupport(
            [{ tool, server: ["pickFlight"] }],
            [{ tool: tool.id, elicits: ["duplicate", "pickSeat"] }],
          ),
        ).toThrow("Duplicate elicit effect ID");
        expect(() =>
          createElicitResponder(
            runtime,
            "invalid-plugin",
            {
              ...partial,
              contract: { ...partial.contract, elicits: tool.elicits },
            },
            () => ({}),
          ),
        ).toThrow("Duplicate elicit effect ID");
      }
      const permitted = [{ tool: chooseFlight, server: serverSeat ? ["pickSeat"] : [] }];
      expect(selectToolSupport([{ ...permitted[0]!, server: [] }], [partial.support])).toEqual({
        available: [],
        unavailable: [{ tool: chooseFlight.id, missing: ["pickSeat"] }],
      });
      expect(
        selectToolSupport(permitted, [{ ...session.plugin.support, tool: "unrelated-tool" }])
          .available,
      ).toEqual([]);
      // Advertising another tool cannot add it to the authorized catalog.
      const selected = selectToolSupport(
        permitted,
        JSON.parse(JSON.stringify([session.plugin.support, { tool: "admin-only", elicits: [] }])),
      );
      expect(selected.available).toHaveLength(1);
      expect(selected.unavailable).toEqual([]);
      if (serverSeat) {
        expect(selectToolSupport(permitted, [partial.support]).available).toHaveLength(1);
        const both = { ...session.plugin.support, elicits: ["pickFlight", "pickSeat"] };
        expect(selectToolSupport(permitted, [both]).available[0]!.routes.pickSeat).toBe("server");
      }
      const store = createSqliteJournalRig<
        ChatLoopResult,
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({ program: supportedFlightChat.id, equals: isDeepStrictEqual });
      onTestFinished(() => store.close());
      let journal = store.open();
      function task<T>(work: Work<T, Y>) {
        const running = runtime.start(work);
        void running.result.catch(() => undefined);
        onTestFinished(() => running.cancel());
        return running;
      }
      await task(() =>
        journal.admit(supportedFlightChat.id, {
          prompt: "Book a flight",
          selection: selected.available.map((plan) => ({ ...plan, revision: "legacy-ignored" })),
        }),
      ).result;
      let samples = 0;
      let searches = 0;
      const model = {
        id: "scripted",
        name: "Scripted",
        provider: "local",
        api: "local",
        input: ["text" as const],
        output: ["text" as const],
        contextWindow: 4096,
        maxOutputTokens: 100,
        reasoningLevels: [],
      };
      async function bind() {
        // Load only retained server admission. A reconnect advertisement is not an
        // input to this reconstruction, nor authority to change an existing route.
        const snapshot = await task(() => journal.read()).result;
        const [plan] = z
          .object({ selection: z.array(selectionSchema) })
          .parse(snapshot.admission?.input).selection;
        if (
          !plan ||
          plan.tool !== chooseFlight.id ||
          plan.routes.pickFlight !== "client" ||
          !["client", "server"].includes(plan.routes.pickSeat)
        ) {
          throw new Error("Unsupported retained assembly");
        }
        const recovery = <R,>(
          options: Parameters<
            typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
          >[1],
        ) => createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, options);
        const tool = createChatToolBinding(runtime, chooseFlight, {
          definition: {
            name: "choose_flight",
            description: "Choose flight",
            parameters: {
              type: "object",
              properties: { destination: { type: "string" } },
              required: ["destination"],
            },
          },
          recovery,
          matches: isDeepStrictEqual,
          *configure({ host, effects }) {
            for (const tool of collidingTools) {
              const request = { effect: chooseFlight.elicits.pickFlight.id, input: [] };
              const before = yield* host.operations.deliveryMode(request);
              const rejected = yield* runtime.composition.catchError(
                () =>
                  installSelectedElicitHandlers(
                    host,
                    effects,
                    tool,
                    {
                      tool: tool.id,
                      routes: { pickFlight: "server", duplicate: "client", pickSeat: "client" },
                    },
                    {
                      *pickFlight() {
                        return { ok: true, value: "flight-1" };
                      },
                    },
                  ),
                function* (error) {
                  return String(error);
                },
              );
              expect(rejected).toContain("Duplicate elicit effect ID");
              expect(yield* host.operations.deliveryMode(request)).toBe(before);
            }
            // Rejection must leave no server implementation installed. Installing
            // one now succeeds; the retained client route below must still park.
            yield* effects.install(chooseFlight.elicits.pickFlight, function* () {
              throw new Error("Client route executed an unselected server handler");
            });
            const failure = yield* runtime.composition.catchError(
              () =>
                installSelectedElicitHandlers(host, effects, chooseFlight, {
                  ...plan,
                  routes: { ...plan.routes, pickFlight: "server" },
                }),
              function* (error) {
                return String(error);
              },
            );
            expect(failure).toContain("Missing selected server handler: pickFlight");
            yield* installSelectedElicitHandlers(host, effects, chooseFlight, plan, {
              *pickFlight() {
                throw new Error("Client route executed an unselected server handler");
              },
              *pickSeat(input) {
                serverSeats++;
                expect(input.flight).toBe("flight-1");
                return { ok: true, value: "2B" };
              },
            });
            yield* effects.install(searchFlights, function* () {
              searches++;
              return { ok: true, value: [{ id: "flight-1", airline: "SkyHigh" }] };
            });
            yield* effects.install(travelTip, function* () {
              return { ok: true, value: { text: "Take the shuttle", model } };
            });
          },
        });
        return supportedFlightChat.bind(runtime, {
          journal,
          tools: [tool],
          recovery,
          matches: isDeepStrictEqual,
          sampling: {
            *sample(request) {
              samples++;
              expect(request.tools.map((definition) => definition.name)).toEqual(["choose_flight"]);
              return {
                ok: true,
                value: {
                  model,
                  response: {
                    message: {
                      role: "assistant",
                      content:
                        request.round === 0
                          ? [
                              {
                                type: "tool-call",
                                toolCall: {
                                  id: "booking",
                                  name: "choose_flight",
                                  input: { destination: "LAX" },
                                  thoughtSignature: null,
                                },
                              },
                            ]
                          : [{ type: "text", text: "Booked" }],
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
          },
        });
      }
      let chat = await bind();
      async function questions() {
        return task(function* () {
          const stream = yield* chat.interactions();
          const found: ToolInteraction[] = [];
          while (true) {
            const item = yield* stream.next();
            if (item.done) {
              return found;
            }
            found.push(item.value);
          }
        }).result;
      }
      expect(await task(() => chat.run()).result).toMatchObject({
        state: "child",
        reason: "waiting",
      });
      const [flight] = await questions();
      expect(flight!.declaration.id).toBe(chooseFlight.elicits.pickFlight.id);
      // A different frontend could not start this tool now. It may observe the
      // parked execution, but cannot reroute it or pretend it can answer it.
      expect(selectToolSupport(permitted, []).available).toEqual([]);
      const unsupported = defineElicitPlugin(chooseFlight).onElicit({});
      journal = store.reopen();
      chat = await bind();
      expect(await task(() => chat.run()).result).toMatchObject({
        state: "child",
        reason: "waiting",
      });
      expect(await questions()).toMatchObject([
        { execution: flight!.execution, grant: flight!.grant, input: flight!.input },
      ]);
      await expect(
        task(() =>
          createElicitResponder(runtime, "unsupported", unsupported, () => ({})).operations.respond(
            selected.available[0]!,
            flight!,
          ),
        ).result,
      ).rejects.toThrow("No compatible local handler");
      await expect(
        task(() =>
          session.responder.operations.respond(
            { ...selected.available[0]!, tool: "another-tool" },
            flight!,
          ),
        ).result,
      ).rejects.toThrow("No compatible local handler");
      const first = createElicitResponder(runtime, "first-session", sharedDeclaration, () => ({
        choice: "flight-1" as const,
      }));
      const second = createElicitResponder(runtime, "second-session", sharedDeclaration, () => ({
        choice: "flight-2" as const,
      }));
      const layers: string[] = [];
      expect(Object.isFrozen(sharedDeclaration)).toBe(true);
      expect(Object.isFrozen(sharedDeclaration.support.elicits)).toBe(true);
      const isolated = await task(function* () {
        yield* first.around({
          *respond(args, next) {
            layers.push("before");
            const value = yield* next(...args);
            layers.push("after");
            return value;
          },
        });
        const one = yield* first.operations.respond(selected.available[0]!, flight!);
        const two = yield* second.operations.respond(selected.available[0]!, flight!);
        return [one, two];
      }).result;
      expect(isolated).toEqual([
        { ok: true, value: "flight-1" },
        { ok: true, value: "flight-2" },
      ]);
      expect(layers).toEqual(["before", "after"]);
      await task(() => first.operations.respond(selected.available[0]!, flight!)).result;
      expect(layers).toEqual(["before", "after"]); // Middleware ended with its scope.
      await expect(
        task(() =>
          first.operations.respond(selected.available[0]!, { ...flight!, input: "invalid" }),
        ).result,
      ).rejects.toThrow("Invalid elicit context");
      const answer = await task(() =>
        session.responder.operations.respond(selected.available[0]!, flight!),
      ).result;
      await task(() => chat.answer(flight!, answer)).result;
      expect(samples).toBe(1); // Answering does not advance the execution.
      const progressed = await task(() => chat.run()).result;
      if (!serverSeat) {
        expect(progressed).toMatchObject({ state: "child", reason: "waiting" });
        const [seat] = await questions();
        const pending = task(() =>
          session.responder.operations.respond(selected.available[0]!, seat!),
        );
        await within(ui.container).findByRole("button", { name: "Seat 2A" });
        expect(session.host.getSnapshot()[0]!.interaction).toMatchObject({
          execution: seat!.execution,
          requestId: seat!.grant.requestId,
          resolutionId: seat!.grant.resolutionId,
        });
        const oldNode = session.host.getSnapshot()[0]!.node;
        if (!isValidElement<{ onRespond: (seat: "2A" | "2B") => void }>(oldNode)) {
          throw new Error("Expected a seat component");
        }
        const staleRespond = oldNode.props.onRespond;
        // Views subscribe independently; dropping one does not own handler cancellation.
        ui.unmount();
        expect(session.host.getSnapshot()).toHaveLength(1);
        ui = render(<ElicitViews host={session.host} />);
        expect(within(ui.container).getByRole("button", { name: "Seat 2A" })).toBeTruthy();
        // The frontend session owner explicitly stops the handler on disconnect.
        await act(async () => {
          await pending.cancel();
        });
        expect(session.host.getSnapshot()).toEqual([]);
        expect(await questions()).toMatchObject([{ grant: seat!.grant }]);
        ui.unmount();
        journal = store.reopen();
        chat = await bind();
        const [restored] = await questions();
        expect(restored).toMatchObject({ execution: seat!.execution, grant: seat!.grant });
        session = createFrontend();
        ui = render(<ElicitViews host={session.host} />);
        const resumed = task(() =>
          session.responder.operations.respond(selected.available[0]!, restored!),
        );
        const button = await within(ui.container).findByRole("button", { name: "Seat 2A" });
        // A callback retained by the discarded UI cannot answer the new render.
        act(() => {
          staleRespond("2B");
        });
        expect(session.host.getSnapshot()).toHaveLength(1);
        const currentNode = session.host.getSnapshot()[0]!.node;
        if (!isValidElement<{ onRespond: (seat: "2A" | "2B") => void }>(currentNode)) {
          throw new Error("Expected a seat component");
        }
        let outcome: Awaited<typeof resumed.result>;
        await act(async () => {
          fireEvent.click(button);
          currentNode.props.onRespond("2B"); // First response wins locally.
          outcome = await resumed.result;
        });
        expect(outcome!).toEqual({ ok: true, value: "2A" });
        expect(session.host.getSnapshot()).toEqual([]);
        expect(await questions()).toHaveLength(1); // UI completion is not durable acceptance.
        await task(() => chat.answer(restored!, outcome!)).result;
        journal = store.reopen();
        chat = await bind();
        expect(await task(() => chat.run()).result).toMatchObject({ state: "completed" });
      } else {
        expect(progressed).toMatchObject({ state: "completed" });
      }
      expect(await questions()).toEqual([]);
      expect(handledFlights).toBe(1);
      expect(handledSeats).toBe(serverSeat ? 0 : 2);
      expect(serverSeats).toBe(serverSeat ? 1 : 0);
      expect(searches).toBe(1);
      expect(samples).toBe(2);
      journal = store.reopen();
      chat = await bind();
      expect(await task(() => chat.run()).result).toMatchObject({ state: "completed" });
      expect(samples).toBe(2);
    });
  }
});
