# Purpose

Propose an alternative API for defining agents that aligns better with Effection
to leverage Structure Concurrency and simplify the API. The simplifaction comes
from dramatically reducing API surface and leveraging Effection features and
middleware.

## Approach

At the high level, the API is designed for composition and flexibility.

### Composition

Composition has 3 levels: program, agents and tools.

#### Program level

The program level is the entrypoint into the program. This is where all of the root Effections contexts are set.
This is where you would load configuration, instantiate all of the agents that start when the program starts. 

```ts
import z from "zod";
import { Ok, Err, main } from "effection";
import { createAgent, createTool, createServer, createMCP, useModel, useConfig } from "@sweatpants/core";
import { notify, elicit, sample, log } from "@sweatpants/agent";

await main(function* () {
  const config = yield* useConfig();

  const server = createServer({
    // this would probably be the default
    host: config.server.host,
    port: config.server.port,
  });

  // this would be built in behavior, but I'm show it as an example
  yield* useModel(config.defaults.provider, config.defaults.model);

  // I'm not sure about everything below
  const agent = yield* Chat;
  const mcp = yield* MCP.config({
    protocol: config.mcp.protocol
  });

  server.use('/chat', agent);

  yield* agent.use(mcp);

  yield server;
});
```

#### Agent Level

Each agent has a role. It's role is defined by the tools that it uses.
Agents can use other agent's tools. The configuration for each agent is 
set at the root level. In the example below, the Chat agent is the 
orchestrating agent. It uses the Flight agent. 

#### Tool Level

At the tool level, we can use other agent's tool and own tools.

```ts
const Chat = createAgent({
  bookFlight: createTool("book-flight")
    ...
    .execute(function*(trip) {
      ...
      // the type here would be the return type of execute
      const result = yield* Flight.tools.search({
        destination,
        date,
      });
      ...
    })
});
```

The tools for each agent are designed to be usable as standalone functions like the
once provided by `@sweatpants/core` such as `notify`, `elicit`, `sample` 
and `log`. These functions access teh context to get configuration and 
determine which model to use.

```ts
const Chat = createAgent({
  bookFlight: createTool("book-flight")
});

export const { bookFlight } = Chat.tools;
```

This allows each tool to be exported as a standalone function that can be used in agents
that are distributed as libraries.

### Flexibility

Flexibility comes from having middleware built into the core of every aspect of Sweatpants.
This allows controlling execution of every tool and it's context from the program level 
or agent level. To understand middleware, you need keep in mind the following.

You can configure middleware at the root,
```ts
import { around } from '@sweatpants/core'

await main(function*() {
  yield* around({
    *sample([{ prompt, maxTokens }], next) {
      // here you can control what happens before sample is called
      // you can change arguments sent to sample or modify it's context
      const result = yield* next({ prompt, maxTokens });
      // here you can decide what to do with the result
      // you can modify it, invoke other code
      return result; // you must return if the function has a return value
    },
    // same can be done for each of the following: 
    notify, 
    elicit,
    log([message, options], next) {
      // it's common to want to add metadata to log
      return next(message, {
        ...options,
        metadata: ['XYZ']
      })
    }
  });
})
```

The same can be done for each agent's tools.
```ts
await main(function*() {
  yield* Flight.around({
    search([{ destination, date }], next) {
      // you can enrich destination or date before it's sent to default function
      const result = yield* next({ destination, date });
      // you can modify the result.
      return result;
    }
  })
});

```

#### Use case: Prevent leaking PID to models

When agents process user data, they may encounter personal identifying information (PII) such as emails, phone numbers, or social security numbers. Middleware allows you to intercept and redact this sensitive data before it reaches the model.

```ts
await main(function*() {
  // Helper function to redact common PII patterns
  function redactPII(text: string): string {
    return text
      // Email addresses
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL REDACTED]')
      // Phone numbers (various formats)
      .replace(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[PHONE REDACTED]')
      // SSN
      .replace(/\d{3}[-.\s]?\d{2}[-.\s]?\d{4}/g, '[SSN REDACTED]')
      // Credit card numbers
      .replace(/\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}/g, '[CARD REDACTED]');
  }

  yield* around({
    // Intercept all sample calls to sanitize PII in prompts and responses
    *sample([{ prompt, maxTokens }], next) {
      // Redact PII from the prompt before sending to model
      const sanitizedPrompt = redactPII(prompt);
      const result = yield* next({ prompt: sanitizedPrompt, maxTokens });
      return result;
    }
  });

  // You can also wrap specific agent tools that handle user data
  yield* CustomerAgent.around({
    *lookupCustomer([{ customerId }], next) {
      const result = yield* next({ customerId });

      if (result.ok) {
        // Redact PII from customer data before returning to the model
        return Ok({
          ...result.value,
          email: '[EMAIL REDACTED]',
          phone: '[PHONE REDACTED]',
          ssn: '[SSN REDACTED]',
          // Keep non-sensitive fields
          name: result.value.name,
          accountStatus: result.value.accountStatus
        });
      }

      return result;
    }
  });
});
```

This pattern ensures that sensitive personal information never reaches the model, maintaining user privacy while still allowing agents to process and respond to user requests.

#### Use case: Controlling HTTP retry with Context boundaries

Let's say you have a tool that calls other agents which in turn might call other agents. Some of those agents might be flaky so you want to give them more retry attempts. Using Effection's Context API, you can establish scope-local configuration that flows down to nested operations without global mutation.

```ts
import { Context } from 'effection';
import { createAgent, createTool } from '@sweatpants/core';

// Define a context for HTTP configuration
const HttpConfig = Context.create<{ retries: number; timeout: number }>('http-config', {
  retries: 3,
  timeout: 5000
});

await main(function*() {
  // Set default HTTP config at the root level
  yield* HttpConfig.set({ retries: 3, timeout: 5000 });

  // For flaky external services, increase retries in that scope
  yield* HttpConfig.with({ retries: 10, timeout: 15000 }, function*() {
    // All operations within this scope inherit the increased retry config
    yield* ExternalServiceAgent.tools.fetchData({ endpoint: '/unstable-api' });
  });

  // Outside the scope, config returns to default
  yield* InternalAgent.tools.getData({ id: '123' }); // Uses default: 3 retries, 5000ms timeout
});

// Tools can read the current context to respect the configuration
const ExternalServiceAgent = createAgent({
  fetchData: createTool('fetch-data')
    .parameters(z.object({ endpoint: z.string() }))
    .execute(function*({ endpoint }) {
      const config = yield* HttpConfig.get();

      let lastError;
      for (let attempt = 0; attempt < config.retries; attempt++) {
        try {
          const response = yield* fetchWithTimeout(endpoint, config.timeout);
          return Ok(response);
        } catch (error) {
          lastError = error;
          yield* log('warn', `Attempt ${attempt + 1}/${config.retries} failed, retrying...`);
        }
      }

      return Err(lastError);
    })
});
```

This pattern leverages Effection's structured concurrency to ensure configuration changes are scoped and don't leak across boundaries. Children inherit parent context, but modifications in child scopes don't affect siblings or parents.

# Example

```ts
import z from "zod";
import { Ok, Err, main } from "effection";
import { createAgent, createTool, createServer, createMCP, useModel, useConfig } from "@sweatpants/core";
import { notify, elicit, sample, log } from "@sweatpants/agent";

await main(function* () {
  const config = yield* useConfig();

  const server = createServer({
    // this would probably be the default
    host: config.server.host,
    port: config.server.port,
  });

  // this would be built in behavior, but I'm show it as an example
  yield* useModel(config.defaults.provider, config.defaults.model);

  // I'm not sure about everything below
  const agent = yield* Chat;
  const mcp = yield* MCP;

  server.use('/chat', agent);

  yield* agent.use(mcp);

  yield server;
});

const MCP = createMPC({
  tools: [
    Chat.tools.bookFlight,
  ]
})

const Chat = createAgent({
  bookFlight: createTool("book-flight")
    .description("Search for a flight and book it")
    .parameter(
      z.string().describe("Description of a trip")
    )
    .execute(function*(trip) {
      let destination, date;
      while (!destination && !date) {
        // let's pretend this returns structured data
        const summary = yield* sample({
          prompt: `
            input: ${trip}
            output: Destination and date of desired trip
            confidence_level: 0-1
            confidence_reason: explanation of the confidence level for the user
          `,
          maxTokens: 150,
        });

        if (summary.confidence * 100 > 80) {
          destination = summary.destination;
          date = summary.date;
          break;
        } else {
          yield* notify(summary.confidence_reason);
        }
      }

      // the type here would be the return type of execute
      const result = yield* Flight.tools.search({
        destination,
        date,
      });

      if (!result.ok) {
        return result;
      }

      const booking = yield* Flight.tools.search({
        id: result.value.flight,
        seat: result.value.seatPreference
      });
    })
});


const Flight = createAgent({
  search: createTool("search")
    .description("Search and select a flight")
    .parameters(
      z.object({
        destination: z.string().describe("Destination city or airport code"),
        date: z.string().describe("Travel date (YYYY-MM-DD)"),
      }),
    )
    .execute(function* ({ destination, date }) {
      const flights = yield* searchFlights({ destination, date });

      yield* notify("Found available flights", 0.2);

      // Format flights for display
      const flightOptions = flights
        .map(
          (f) =>
            `${f.id}: ${f.airline} - ${f.departure} to ${f.arrival} ($${f.price})`,
        )
        .join("\n");

      // First elicitation: Pick a flight
      const selection = yield* elicitFlightSelection(flightOptions);

      // Handle user declining
      if (selection.action === "decline") {
        yield* log("info", "User declined flight selection");
        return Err(new Error("user_declined_selection"));
      }

      // Handle user cancelling (dismissing dialog)
      if (selection.action === "cancel") {
        yield* log("info", "User cancelled flight selection");
        return Err(new Error("user_cancelled"));
      }

      // Find the selected flight
      const selectedFlight = flights.find(
        (f) => f.id === selection.content.flightId,
      );

      if (!selectedFlight) {
        return Err(new Error("invalid_flight_id"));
      }

      return Ok({
        flight: selectedFlight,
        seatPreference
      })
    }),

  book: createSearch("book")
    .description("Book a flight by id")
    .parameters({
      id: z.number().required().description("ID of the flight that user wants to book"),
      seat: z
        .enum(["window", "aisle", "middle"])
        .describe("Seat preference"),
    })
    .execute: function*({ id, seat }) {
      
      const flight = yield* fetch(`/api/flights/${id}`);

      const summary = yield* sample({
        prompt: `Summarize this flight booking in a friendly, concise way:
          - Flight: ${flight.airline} ${flight.id}
          - Route: Departing ${flight.departure}, arriving ${flight.arrival}
          - Price: $${flight.price}
          - Seat preference: ${seat}
          - Date: ${flight.date}
          - Destination: ${flight.destination}`,
        maxTokens: 150,
      });

      yield* notify('Please confirm booking', 0.8)

      // Second elicitation: Confirm booking
      const confirmation = yield* elicitConfirmation();

      if (confirmation.action !== 'accept' || !confirmation.content.confirmed) {
        yield* log('info', 'User did not confirm booking')
        return Err(new Error('not_confirmed'))
      }

      yield* notify('Creating booking...', 0.9)

      // Return successful selection for after() phase
      return ok({
        flightId: selection.content.flightId,
        seatPreference: selection.content.seatPreference,
      })
    }
});

function elicitConfirmation(summary) {
  return elicit({
    message: `${summary}\n\nConfirm this booking?`,
    schema: z.object({
      confirmed: z.boolean().describe('Confirm the booking'),
    }),
  })
}

function elicitFlightSelection({
  flightOptions,
  destination,
  date,
}: {
  flightOptions: string;
  destination: string;
  date: string;
}) {
  // This function will return an operation which allows to yield* elicitFlightSelectinon()
  return elicit({
    message: `Available flights to ${destination} on ${date}:\n\n${flightOptions}\n\nSelect a flight and seat preference:`,
    schema: z.object({
      flightId: z.string().describe("Flight ID (e.g., FL001)"),
      seatPreference: z
        .enum(["window", "aisle", "middle"])
        .describe("Seat preference"),
    }),
  });
}**
```

