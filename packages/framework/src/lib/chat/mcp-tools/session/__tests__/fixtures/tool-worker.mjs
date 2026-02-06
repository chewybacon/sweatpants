import { runWorker, createWorkerToolRegistry } from "@sweatpants/framework/chat/mcp-tools/worker";

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

    if (response.action === "cancel") {
      return { action, wasCancelled: true };
    }
    
    if (response.action !== "accept") {
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
    
    if (elicitResult.action !== "accept") {
      return { greeting: null, cancelled: true };
    }
    
    const content = elicitResult.content;
    if (content.edited && content.newGreeting) {
      return { greeting: content.newGreeting, wasEdited: true };
    }
    
    return { greeting: generatedGreeting, wasEdited: false };
  },

  /**
   * Elicit with context - tests context data passing through elicit calls
   */
  elicit_with_context: function* (params, ctx) {
    const { flights } = params;
    
    // Elicit with context data (the new feature we added)
    const result = yield* ctx.elicit("pickFlight", {
      message: "Select a flight",
      schema: {
        type: "object",
        properties: { flightId: { type: "string" } },
        required: ["flightId"],
      },
      context: { flights, totalOptions: flights.length },
    });
    
    if (result.action !== "accept") {
      return { cancelled: true };
    }
    
    return { selectedFlightId: result.content.flightId };
  },

  /**
   * Elicit with SPREAD context - tests MCP-style spread context format
   */
  elicit_spread_context: function* (params, ctx) {
    const { flights } = params;

    const result = yield* ctx.elicit("pickFlight", {
      message: "Select a flight",
      schema: {
        type: "object",
        properties: { flightId: { type: "string" } },
        required: ["flightId"],
      },
      flights,
      totalOptions: flights.length,
    });

    if (result.action !== "accept") {
      return { cancelled: true };
    }

    return { selectedFlightId: result.content.flightId };
  },

  /**
   * Sample with all optional fields - tests systemPrompt, maxTokens, modelPreferences
   */
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
    
    return {
      text: response.text,
      model: response.model,
    };
  },

  /**
   * Sample with parsed response - tests the parsed field in sample results
   */
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

  /**
   * Sample with tool calls - tests the toolCalls field in sample results
   */
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

  /**
   * Book Flight Tool - mimics the book_flight e2e flow
   * 
   * Flow:
   * 1. elicit(pickFlight) → user selects a flight
   * 2. elicit(pickSeat) → user selects a seat
   * 3. sample() → get travel tip
   * 4. return booking confirmation
   */
  book_flight: function* (params, ctx) {
    const { from, destination } = params;
    
    // Mock flight data
    const flights = [
      { id: "FL001", airline: "SkyHigh", price: 299 },
      { id: "FL002", airline: "CloudAir", price: 349 },
    ];
    
    // Step 1: Elicit flight selection
    const flightResult = yield* ctx.elicit("pickFlight", {
      message: `Select a flight from ${from} to ${destination}`,
      schema: {
        type: "object",
        properties: {
          flightId: { type: "string" },
        },
        required: ["flightId"],
      },
    });
    
    if (flightResult.action !== "accept") {
      return { success: false, reason: "flight_not_selected" };
    }
    
    const selectedFlight = flights.find(f => f.id === flightResult.content.flightId);
    if (!selectedFlight) {
      return { success: false, reason: "invalid_flight" };
    }
    
    // Step 2: Elicit seat selection
    const seatResult = yield* ctx.elicit("pickSeat", {
      message: `Select your seat on ${selectedFlight.airline}`,
      schema: {
        type: "object",
        properties: {
          row: { type: "number" },
          seat: { type: "string" },
        },
        required: ["row", "seat"],
      },
    });
    
    if (seatResult.action !== "accept") {
      return { success: false, reason: "seat_not_selected" };
    }
    
    const seatCode = `${seatResult.content.row}${seatResult.content.seat}`;
    
    // Step 3: Sample for travel tip
    const tipResponse = yield* ctx.sample({
      messages: [{ role: "user", content: `Give a travel tip for ${destination}` }],
      maxTokens: 50,
    });
    
    // Step 4: Return booking confirmation
    return {
      success: true,
      ticketNumber: "TKT-TEST123",
      flight: {
        id: selectedFlight.id,
        airline: selectedFlight.airline,
      },
      seat: seatCode,
      price: selectedFlight.price,
      route: { from, to: destination },
      travelTip: tipResponse.text,
    };
  },
};

const registry = createWorkerToolRegistry(
  Object.entries(tools).map(([name, handler]) => ({ name, handler }))
);

runWorker(registry).catch((error) => {
  console.error(error);
});
