import { runToolWorker } from "../../../../../../../../core/dist/transport/worker.js";

const tools = {
  echo: function* (params) {
    const { message } = params;
    return { echoed: message };
  },
  greeter: function* (params, ctx) {
    const { name } = params;
    const response = yield* ctx.sample({
      messages: [{ role: "user", content: `Say hello to ${name}` }],
      maxTokens: 50,
    });

    return {
      greeting: response.text,
      model: response.model,
    };
  },
  confirmer: function* (params, ctx) {
    const { action } = params;
    const response = yield* ctx.elicit("confirm", {
      message: `Are you sure you want to ${action}?`,
      schema: {
        type: "object",
        properties: { confirmed: { type: "boolean" } },
        required: ["confirmed"],
      },
    });

    if (response.status !== "accepted") {
      return { cancelled: true };
    }

    return {
      action,
      confirmed: Boolean(response.content && response.content.confirmed),
    };
  },
};

runToolWorker(function* (initData, ctx) {
  const tool = tools[initData.toolName];
  if (!tool) {
    throw new Error(`Unknown tool: ${initData.toolName}`);
  }
  return yield* tool(initData.params ?? {}, ctx);
}).catch((error) => {
  console.error(error);
});
