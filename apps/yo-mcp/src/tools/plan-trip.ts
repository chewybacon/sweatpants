import { createDurableTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

/** Multiple interactions and revision, all within one journal invocation. */
export const planTripTool = createDurableTool("plan_trip", { version: "1" })
  .description(
    "Plan a day trip together: choose a destination and activity, then review or revise. Does not book anything.",
  )
  .parameters(
    z.object({
      traveler: z.string().min(1).default("Traveler").describe("Who the day trip is for"),
    }),
  )
  .effects({})
  .elicits({
    destination: { response: z.object({ city: z.string().min(1).describe("City to visit") }) },
    activity: {
      response: z.object({
        activity: z.enum(["museum", "food tour", "park"]).describe("Activity for the day trip"),
      }),
    },
    review: {
      response: z.object({
        confirmed: z
          .boolean()
          .default(false)
          .describe("Confirm this plan; leave unchecked to choose another activity"),
      }),
    },
  })
  .execute(function* ({ traveler }, ctx) {
    const destination = yield* ctx.elicit("destination", {
      message: `${traveler}, which city would you like to visit?`,
    });
    if (destination.action !== "accept") {
      return { status: destination.action, stage: "destination" };
    }

    const city = destination.content.city;
    while (true) {
      const choice = yield* ctx.elicit("activity", {
        message: `What would you like to do in ${city}?`,
      });
      if (choice.action !== "accept") {
        return { status: choice.action, stage: "activity" };
      }

      const activity = choice.content.activity;
      const review = yield* ctx.elicit("review", {
        message: `Day trip for ${traveler}: ${city}, with a ${activity}. Confirm this plan, or submit with confirmed unchecked to choose another activity. Nothing will be booked.`,
      });
      if (review.action !== "accept") {
        return { status: review.action, stage: "review" };
      }
      if (review.content.confirmed) {
        return { status: "planned", traveler, city, activity };
      }
    }
  });
