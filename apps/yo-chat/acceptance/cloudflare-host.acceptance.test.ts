// @vitest-environment node
import { describe, expect, it } from "vitest";
import { call, race, spawn } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { startCloudflareChatHost } from "./fixtures/cloudflare-chat-host";

describe.each(["worker", "durable-object"] as const)("%s conversation host", (placement) => {
  it("replays a parked card after the entire Worker host is replaced", async () => {
    let host: Awaited<ReturnType<typeof startCloudflareChatHost>>;
    await withTestScenario(
      {
        binding: "in-process",
        modelId: "worker-host-test",
        async createApplication(context) {
          host = await startCloudflareChatHost(context.model, placement);
          return host;
        },
        scenarioTimeoutMs: 20_000,
      },
      function* (s) {
        const conversation = s.conversation();
        const first = yield* conversation.send("Pick a card");
        const outer = yield* race([
          s.model.request(),
          (function* () {
            throw new Error(JSON.stringify(yield* first.failure()));
          })(),
        ]);
        yield* outer.respond.toolCalls([
          { id: "cards-1", name: "pick_card", arguments: { count: 3 } },
        ]);
        const choice = yield* first.elicit("pickCard");
        const cards = (
          choice.context as { cards: Array<{ rank: string; suit: string; display: string }> }
        ).cards;
        expect(cards).toHaveLength(3);
        yield* call(() => host.replace());
        const reopened = yield* conversation.reopen();
        expect(JSON.stringify(reopened.snapshot())).toContain(choice.elicitId);
        const resumed = reopened.resumePendingElicit("pickCard");
        const recovered = yield* resumed.elicit("pickCard");
        expect(recovered.context).toEqual(choice.context);
        yield* recovered.accept({ picked: cards[0] });
        const final = yield* race([
          s.model.request(),
          (function* () {
            throw new Error(JSON.stringify(yield* resumed.failure()));
          })(),
        ]);
        expect(JSON.stringify(final.body.input)).toContain("Card selection recorded");
        yield* final.respond.text(`You picked ${cards[0]!.display}.`);
        expect((yield* resumed.settled()).text).toContain(cards[0]!.display);
        const next = yield* reopened.send("What card did I pick?");
        const recall = yield* s.model.request();
        expect(JSON.stringify(recall.body.input)).toContain(cards[0]!.display);
        yield* recall.respond.text(`You picked ${cards[0]!.display}.`);
        expect((yield* next.settled()).text).toContain(cards[0]!.display);
      },
    );
  }, 30_000);

  it("keeps the ordinary flight generator in a DO across request-owned hosts", async () => {
    await withTestScenario(
      {
        binding: "in-process",
        modelId: "worker-host-test",
        createApplication: ({ model }) => startCloudflareChatHost(model, placement),
        scenarioTimeoutMs: 20_000,
      },
      function* (s) {
        const conversation = s.conversation();
        const first = yield* conversation.send("Book NYC to LAX");
        const outer = yield* s.model.request();
        yield* outer.respond.toolCalls([
          { id: "flight-1", name: "book_flight", arguments: { from: "NYC", destination: "LAX" } },
        ]);
        const flight = yield* first.elicit("pickFlight");
        const reopened = yield* conversation.reopen();
        const resumed = reopened.resumePendingElicit("pickFlight");
        const recoveredFlight = yield* resumed.elicit("pickFlight");
        expect(recoveredFlight.elicitId).toBe(flight.elicitId);
        yield* recoveredFlight.accept({ flightId: "FL001" });
        const seat = yield* resumed.elicit("pickSeat");
        expect(JSON.stringify(seat.context)).toContain("SH 142");
        const refreshed = yield* reopened.reopen();
        const booking = refreshed.resumePendingElicit("pickSeat");
        const recoveredSeat = yield* booking.elicit("pickSeat");
        expect(recoveredSeat.elicitId).toBe(seat.elicitId);
        yield* recoveredSeat.accept({ row: 2, seat: "A" });
        const tip = yield* s.model.request();
        expect(JSON.stringify(tip.body.input)).toContain("travel tip");
        yield* tip.respond.text("Allow time for airport transfers.");
        const final = yield* s.model.request();
        expect(JSON.stringify(final.body.input)).toContain("TKT-");
        expect(JSON.stringify(final.body.input)).toContain("2A");
        yield* final.respond.text("Booked SH 142, seat 2A.");
        expect((yield* booking.settled()).text).toContain("seat 2A");
      },
    );
  }, 30_000);

  it("finishes tic-tac-toe through DO executors with a refreshed board", async () => {
    await withTestScenario(
      {
        binding: "in-process",
        modelId: "worker-host-test",
        createApplication: ({ model }) => startCloudflareChatHost(model, placement),
        scenarioTimeoutMs: 20_000,
      },
      function* (s) {
        const conversation = s.conversation();
        let turn = yield* conversation.send("Play tic-tac-toe");
        const outer = yield* s.model.request();
        yield* outer.respond.toolCalls([{ id: "game-1", name: "play_ttt", arguments: {} }]);
        const model = yield* spawn(function* () {
          while (true) {
            const request = yield* s.model.request();
            const input = JSON.stringify(request.body.input);
            const match = /Empty positions: (\d)/.exec(input);
            if (!match) {
              expect(input).toMatch(/model_wins|user_wins|draw/);
              yield* request.respond.text("Game complete.");
              return;
            }
            yield* request.respond.text(JSON.stringify({ cell: Number(match[1]) }));
          }
        });
        let refreshed = false;
        let finished = false;
        for (let step = 0; step < 10; step++) {
          let move = yield* turn.elicit("pickMove");
          if (!refreshed) {
            const reopened = yield* conversation.reopen();
            turn = reopened.resumePendingElicit("pickMove");
            const recovered = yield* turn.elicit("pickMove");
            expect(recovered.context).toEqual(move.context);
            move = recovered;
            refreshed = true;
          }
          const board = move.context as {
            board: Array<string | null>;
            gameOver?: boolean;
            resultMessage?: string;
          };
          if (board.gameOver) {
            expect(board.resultMessage).toMatch(/win|draw/i);
            yield* move.accept({ position: -1 });
            finished = true;
            break;
          }
          yield* move.accept({ position: board.board.indexOf(null) });
        }
        expect(finished).toBe(true);
        yield* model;
        expect((yield* turn.settled()).text).toContain("Game complete.");
      },
    );
  }, 30_000);

  it("recovers a refreshed game when its nested model request loses the Worker", async () => {
    let host: Awaited<ReturnType<typeof startCloudflareChatHost>>;
    let phase = "starting conversation";
    await withTestScenario(
      {
        binding: "in-process",
        modelId: "worker-host-test",
        async createApplication({ model }) {
          host = await startCloudflareChatHost(model, placement);
          return host;
        },
        scenarioTimeoutMs: 20_000,
      },
      function* (s) {
        const conversation = s.conversation();
        const first = yield* conversation.send("Play tic-tac-toe");
        phase = "waiting for outer model";
        const outer = yield* s.model.request();
        yield* outer.respond.toolCalls([{ id: "game-recovery", name: "play_ttt", arguments: {} }]);
        let holdNextSample = false;
        const pendingSample = yield* spawn(function* () {
          while (true) {
            const request = yield* s.model.request();
            expect(JSON.stringify(request.body.input)).toContain("Empty positions:");
            if (holdNextSample) {
              return request;
            }
            // If the recorded coin flip puts the model first, choose the center.
            yield* request.respond.text('{"cell":4}');
          }
        });
        const original = yield* first.elicit("pickMove");
        const refreshed = yield* conversation.reopen();
        const resumed = refreshed.resumePendingElicit("pickMove");
        const move = yield* resumed.elicit("pickMove");
        expect(move.context).toEqual(original.context);
        holdNextSample = true;
        yield* move.accept({ position: 0 });
        phase = "waiting for nested model after human move";
        const interrupted = yield* pendingSample;
        // Hold the provider boundary open while replacing compute. No timer or
        // model guess determines when the host is lost.
        yield* call(() => host.replace({ elapsedMs: 30_001 }));
        // A late provider answer belongs to the dead host, not its replacement.
        yield* interrupted.respond.text('{"cell":2}');
        const reopening = yield* spawn(() => refreshed.reopen());
        phase = "waiting for nested model after Worker replacement";
        const replayed = yield* s.model.request();
        expect(replayed.body.input).toEqual(interrupted.body.input);
        yield* replayed.respond.text('{"cell":2}');
        const recovered = yield* reopening;
        const game = recovered.resumePendingElicit("pickMove");
        const next = yield* game.elicit("pickMove");
        const board = next.context as {
          board: Array<string | null>;
          userSymbol: string;
          modelSymbol: string;
        };
        expect(next.elicitId).not.toBe(move.elicitId);
        expect(board.board[0]).toBe(board.userSymbol);
        expect(board.board[2]).toBe(board.modelSymbol);
        yield* next.cancel();
        phase = "waiting for final model after cancellation";
        const final = yield* s.model.request();
        yield* final.respond.text("Game cancelled.");
        expect((yield* game.settled()).text).toContain("Game cancelled.");
      },
    ).catch((error: unknown) => {
      throw new Error(`Cloudflare recovery failed while ${phase}`, { cause: error });
    });
  }, 30_000);
});
