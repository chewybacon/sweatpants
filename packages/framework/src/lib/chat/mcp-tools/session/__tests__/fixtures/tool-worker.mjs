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
  multi_sample: function* (params, ctx) {
    const { count } = params;
    const responses = [];
    
    for (let i = 0; i < count; i++) {
      const response = yield* ctx.sample({
        messages: [{ role: "user", content: `Request ${i + 1}` }],
        maxTokens: 50,
      });
      responses.push(response.text);
    }
    
    return { responses };
  },
  greet_with_confirm: function* (params, ctx) {
    const { name, style } = params;
    
    // Step 1: Generate greeting via sampling
    const sampleResponse = yield* ctx.sample({
      messages: [{ role: "user", content: `Generate a ${style} greeting for ${name}` }],
      maxTokens: 100,
    });
    const generatedGreeting = sampleResponse.text;
    
    // Step 2: Ask user to approve
    const elicitResult = yield* ctx.elicit("approve_greeting", {
      message: `Generated greeting: "${generatedGreeting}"\n\nDo you approve?`,
      schema: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          edited: { type: "boolean" },
          newGreeting: { type: "string" },
        },
      },
    });
    
    if (elicitResult.status !== "accepted") {
      return { greeting: null, cancelled: true };
    }
    
    const content = elicitResult.content;
    if (content.edited && content.newGreeting) {
      return { greeting: content.newGreeting, wasEdited: true };
    }
    
    return { greeting: generatedGreeting, wasEdited: false };
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
