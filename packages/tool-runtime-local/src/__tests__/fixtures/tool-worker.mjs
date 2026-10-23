import { runWorker, createWorkerToolRegistry } from "@sweatpants/tool-runtime-local/worker";

// Only distinct worker exchanges and the local driver smoke tools live here.
const tools = {
  echo: function* (params) {
    const { message } = params;
    return { echoed: message };
  },
  strict_echo: function* (params) {
    const { message } = params;
    return { echoed: message };
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
  sample_with_options: function* (params, ctx) {
    const response = yield* ctx.sample({
      messages: [{ role: "user", content: "Hello" }],
      systemPrompt: "You are a helpful assistant",
      maxTokens: 100,
      modelPreferences: {
        hints: [{ name: "claude-3-5-sonnet" }],
        intelligencePriority: 0.8,
        speedPriority: 0.2,
      },
    });

    const flights = [
      { id: "FL001", airline: "SkyHigh", price: 299 },
      { id: "FL002", airline: "CloudAir", price: 349 },
    ];
    const selection = yield* ctx.elicit("chooseFlight", {
      message: "Choose a flight after sampling",
      schema: {
        type: "object",
        properties: { flightId: { type: "string" } },
        required: ["flightId"],
      },
      context: { flights, totalOptions: flights.length },
    });
    return {
      text: response.text,
      model: response.model,
      selectedFlightId: selection.action === "accept" ? selection.content.flightId : null,
    };
  },
  sample_with_parsed: function* (params, ctx) {
    const response = yield* ctx.sample({
      messages: [{ role: "user", content: "Generate a person object" }],
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      },
    });

    return {
      text: response.text,
      // The parsed field should be available when schema is provided
      parsed: response.parsed,
    };
  },
  sample_with_tools: function* (params, ctx) {
    const response = yield* ctx.sample({
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather",
          inputSchema: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      ],
      toolChoice: { type: "auto" },
    });

    return {
      text: response.text,
      toolCalls: response.toolCalls ?? [],
    };
  },
};

const registry = createWorkerToolRegistry(
  Object.entries(tools).map(([name, handler]) => ({ name, handler })),
);

runWorker(registry).catch((error) => {
  console.error(error);
});
