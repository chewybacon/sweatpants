import { type DurableProgramContextFor } from "@sweatpants/agent-sdk/legacy";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { z } from "zod";

const exchanges = {
  pick: { response: z.strictObject({ seat: z.enum(["window", "aisle"]) }) },
  confirm: { response: z.strictObject({ confirmed: z.boolean() }) },
};
type Context = DurableProgramContextFor<{}, typeof exchanges, false>;

function* pickSeat(ctx: Context, traveler: string) {
  "use workflow";
  const selection = yield* ctx.elicit("pick", { message: traveler });
  return { traveler, selection };
}
function* book(ctx: Context, traveler: string) {
  "use workflow";
  const selected = yield* pickSeat(ctx, traveler);
  const confirmation = yield* ctx.elicit("confirm", { message: selected.traveler });
  return { selected, confirmation };
}
export const booking = createDurableTool("helper-booking", { version: "1" })
  .description("Select a seat and confirm for a traveler")
  .parameters(z.strictObject({ traveler: z.string() }))
  .elicits(exchanges)
  .execute(function* (input, ctx) {
    "use workflow";
    const reservation = yield* book(ctx, input.traveler);
    return { reservation };
  });
