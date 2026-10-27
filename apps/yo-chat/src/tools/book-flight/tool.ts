import { createTool } from "@sweatpants/agent-sdk";
import type { Operation } from "@sweatpants/standard-durability";
import type { JournalRequest } from "@sweatpants/agent-sdk";
import { sleep } from "effection";
import { bookFlightTool as portableBookFlight } from "../primitive/book-flight.ts";
import { PickFlightContextSchema, PickSeatContextSchema } from "../schemas/book-flight.ts";
import { mockFlightSearch, mockSeatMap, generateTicketNumber } from "./backend.ts";
export type { Flight, SeatMap } from "../schemas/book-flight.ts";

/** Ordinary placement of the portable flight body, preserving its native timing policy. */
export const bookFlightTool = createTool(portableBookFlight.name)
  .description(portableBookFlight.description)
  .parameters(portableBookFlight.parameters)
  .elicits(portableBookFlight.elicits)
  .samples()
  .execute(function* (input, ctx) {
    return yield* portableBookFlight.invokeWith(input, "book_flight", function* (request) {
      switch (request.kind) {
        case "effect": {
          if (request.key === "search") {
            const query = portableBookFlight.effects.search.input.parse(request.input);
            return mockFlightSearch(query.from, query.destination);
          }
          if (request.key === "seats") {
            const seats = mockSeatMap();
            yield* sleep(900);
            return seats;
          }
          if (request.key === "ticket") {
            return generateTicketNumber();
          }
          throw new Error(`Unknown flight effect: ${request.key}`);
        }
        case "elicit": {
          if (request.key === "pickFlight") {
            const result = yield* ctx.elicit("pickFlight", {
              message: request.message,
              context: PickFlightContextSchema.parse(request.context),
            });
            return result.action === "accept"
              ? { action: result.action, content: result.content }
              : { action: result.action };
          }
          if (request.key === "pickSeat") {
            const result = yield* ctx.elicit("pickSeat", {
              message: request.message,
              context: PickSeatContextSchema.parse(request.context),
            });
            return result.action === "accept"
              ? { action: result.action, content: result.content }
              : { action: result.action };
          }
          throw new Error(`Unknown flight elicitation: ${request.key}`);
        }
        case "nested-sample":
          return yield* ctx.sample({ prompt: request.prompt, maxTokens: request.maxTokens });
        case "progress":
          yield* ctx.notify(request.message, request.progress);
          // The retained ordinary route pauses after announcing the search result.
          if (request.progress === 0.2) {
            yield* sleep(900);
          }
          return;
        case "log":
          yield* ctx.log(request.level, request.message);
          return;
      }
    });
  });

export type BookFlightResult =
  ReturnType<typeof portableBookFlight.invoke> extends Operation<infer Result, JournalRequest>
    ? Result
    : never;
