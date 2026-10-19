import { register } from "tsx/esm/api";

register();

const { runWorker, createWorkerToolRegistry } =
  await import("../../../../packages/tool-runtime-local/src/worker.ts");
const { bookFlightTool } = await import("../tools/book-flight/tool.ts");

function canonicalWorkerTool(tool) {
  return {
    name: tool.name,
    elicits: tool.elicits,
    handler: function* (params, ctx) {
      const invoke = yield* tool(ctx);
      return yield* invoke(params);
    },
  };
}

const confirmBookingTool = {
  name: "confirm_booking",
  elicits: {
    confirm: {
      response: {
        type: "object",
        properties: { confirmed: { type: "boolean" } },
        required: ["confirmed"],
      },
    },
  },
  handler: function* (params, ctx) {
    const response = yield* ctx.elicit("confirm", {
      message: `Confirm booking for ${params.trip}?`,
      schema: {
        type: "object",
        properties: {
          confirmed: { type: "boolean" },
        },
        required: ["confirmed"],
      },
    });

    if (response.action === "accept" && response.content?.confirmed) {
      return { status: "booked", trip: params.trip };
    }
    if (response.action === "decline") {
      return { status: "declined", trip: params.trip };
    }
    return { status: "cancelled", trip: params.trip };
  },
};

const registry = createWorkerToolRegistry([
  canonicalWorkerTool(bookFlightTool),
  confirmBookingTool,
]);

await runWorker(registry);
