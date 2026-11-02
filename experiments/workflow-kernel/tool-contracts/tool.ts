import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { z } from "zod";

export const pickSeat = createDurableTool("pick_seat", { version: "1" })
  .description("Choose a seat, then confirm.")
  .parameters(z.strictObject({}))
  .elicits({
    pickSeat: { response: z.strictObject({ seat: z.enum(["window", "aisle"]) }) },
    confirm: { response: z.strictObject({ confirmed: z.boolean() }) },
  })
  .execute(function* (_input, ctx) {
    "use workflow";
    const selection = yield* ctx.elicit("pickSeat", { message: "Choose a seat" });
    const confirmation = yield* ctx.elicit("confirm", { message: "Confirm selection" });
    return [selection, confirmation];
  });
