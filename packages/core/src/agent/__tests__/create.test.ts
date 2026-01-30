import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, type Operation } from "effection";
import { z } from "zod";
import { createAgent } from "../create.ts";
import { createTool } from "../../tool/create.ts";
import { createTransportPair } from "../../transport/pair.ts";
import { createCorrelation } from "../../transport/correlation.ts";
import { TransportContext } from "../../context/transport.ts";
import type {
  TransportRequest,
  OperativeTransport,
  ResponseMessage,
} from "../../types/transport.ts";

describe("createAgent", () => {
  describe("agent without config", () => {
    it("should create and activate agent with tools", function* () {
      const Echo = createTool({
        name: "echo",
        description: "Echo input",
        input: z.object({ message: z.string() }),
        output: z.object({ echoed: z.string() }),
        progress: z.object({}),
        impl: function* ({ message }) {
          return { echoed: message };
        },
      });

      const SimpleAgent = createAgent({
        name: "simple",
        description: "A simple agent",
        tools: { echo: Echo },
      });

      expect(SimpleAgent.name).toBe("simple");
      expect(SimpleAgent.description).toBe("A simple agent");

      const agent = yield* SimpleAgent();
      const result = yield* agent.echo({ message: "hello" });

      expect(result).toEqual({ echoed: "hello" });
    });

    it("should activate multiple tools", function* () {
      const Add = createTool({
        name: "add",
        description: "Add numbers",
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ sum: z.number() }),
        progress: z.object({}),
        impl: function* ({ a, b }) {
          return { sum: a + b };
        },
      });

      const Multiply = createTool({
        name: "multiply",
        description: "Multiply numbers",
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ product: z.number() }),
        progress: z.object({}),
        impl: function* ({ a, b }) {
          return { product: a * b };
        },
      });

      const MathAgent = createAgent({
        name: "math",
        description: "Math operations",
        tools: { add: Add, multiply: Multiply },
      });

      const math = yield* MathAgent();

      const sum = yield* math.add({ a: 2, b: 3 });
      expect(sum).toEqual({ sum: 5 });

      const product = yield* math.multiply({ a: 2, b: 3 });
      expect(product).toEqual({ product: 6 });
    });
  });

  describe("agent with config", () => {
    it("should create agent with config schema", function* () {
      const configSchema = z.object({
        prefix: z.string(),
      });

      // Store config for verification
      let capturedPrefix: string | undefined;

      const Greet = createTool({
        name: "greet",
        description: "Greet someone",
        input: z.object({ name: z.string() }),
        output: z.object({ greeting: z.string() }),
        progress: z.object({}),
        impl: function* ({ name }) {
          return { greeting: `Hello, ${name}!` };
        },
      });

      const GreetAgent = createAgent({
        name: "greet",
        description: "Greeting agent",
        config: configSchema,
        tools: { greet: Greet },
      });

      expect(GreetAgent.name).toBe("greet");

      const agent = yield* GreetAgent({ prefix: "Hi" });
      
      // Verify config is accessible
      const config = yield* GreetAgent.useConfig();
      capturedPrefix = config.prefix;
      
      expect(capturedPrefix).toBe("Hi");
      
      const result = yield* agent.greet({ name: "World" });
      expect(result).toEqual({ greeting: "Hello, World!" });
    });

    it("should validate config against schema", function* () {
      const Tool = createTool({
        name: "tool",
        description: "A tool",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          return {};
        },
      });

      const Agent = createAgent({
        name: "agent",
        description: "An agent",
        config: z.object({
          required: z.string(),
          count: z.number().min(1),
        }),
        tools: { tool: Tool },
      });

      let error: Error | undefined;
      try {
        yield* Agent({ required: "test", count: 0 });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      // Zod validation error
      expect(error?.message).toContain("count");
    });

    it("should apply default values from config schema", function* () {
      const configSchema = z.object({
        apiKey: z.string(),
        timeout: z.number().default(5000),
      });
      
      type Config = z.infer<typeof configSchema>;
      let receivedConfig: Config | undefined;

      const Check = createTool({
        name: "check",
        description: "Check config",
        input: z.object({}),
        output: z.object({ timeout: z.number() }),
        progress: z.object({}),
        impl: function* () {
          // We'll capture config from outside
          return { timeout: receivedConfig?.timeout ?? 0 };
        },
      });

      const AgentWithDefaults = createAgent({
        name: "defaults",
        description: "Agent with default config",
        config: configSchema,
        tools: { check: Check },
      });

      // Note: For Zod defaults, we need to pass an object that satisfies the input type
      // The default is applied during parsing
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      yield* AgentWithDefaults({ apiKey: "test" } as z.input<typeof configSchema>);
      
      // Get the parsed config (with defaults applied)
      receivedConfig = yield* AgentWithDefaults.useConfig();
      
      expect(receivedConfig.timeout).toBe(5000);
      expect(receivedConfig.apiKey).toBe("test");
    });
  });

  describe("useConfig() errors", () => {
    it("should throw when useConfig() called outside agent scope", function* () {
      const configSchema = z.object({ key: z.string() });
      
      const Agent = createAgent({
        name: "agent",
        description: "An agent",
        config: configSchema,
        tools: {
          tool: createTool({
            name: "tool",
            description: "A tool",
            input: z.object({}),
            output: z.object({}),
            progress: z.object({}),
            impl: function* () {
              return {};
            },
          }),
        },
      });

      let error: Error | undefined;
      try {
        // Call useConfig without activating the agent
        yield* Agent.useConfig();
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toContain("agent.agent.config");
    });

    it("should throw when useConfig() called on agent without config schema", function* () {
      const AgentNoConfig = createAgent({
        name: "no-config",
        description: "Agent without config",
        tools: {
          tool: createTool({
            name: "tool",
            description: "A tool",
            input: z.object({}),
            output: z.object({}),
            progress: z.object({}),
            impl: function* () {
              return {};
            },
          }),
        },
      });

      let error: Error | undefined;
      try {
        // Agent without config shouldn't have useConfig, but let's verify runtime behavior
        // TypeScript correctly prevents this, so we cast to bypass
        const agentWithUseConfig = AgentNoConfig as unknown as { useConfig: () => Operation<unknown> };
        yield* agentWithUseConfig.useConfig();
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toContain("does not have a config schema");
    });
  });

  describe("multiple agent instances", () => {
    it("should allow multiple agent instances to be activated", function* () {
      const configSchema = z.object({ prefix: z.string() });

      const Agent = createAgent({
        name: "multi",
        description: "Multi-instance agent",
        config: configSchema,
        tools: {
          echo: createTool({
            name: "echo",
            description: "Echo input",
            input: z.object({ msg: z.string() }),
            output: z.object({ result: z.string() }),
            progress: z.object({}),
            impl: function* ({ msg }) {
              return { result: msg };
            },
          }),
        },
      });

      // Activate two instances with different configs
      const agent1 = yield* Agent({ prefix: "Agent1" });
      const agent2 = yield* Agent({ prefix: "Agent2" });

      // Both agents should be activated and functional
      const result1 = yield* agent1.echo({ msg: "hello" });
      const result2 = yield* agent2.echo({ msg: "world" });

      expect(result1).toEqual({ result: "hello" });
      expect(result2).toEqual({ result: "world" });
    });

    it("should make config accessible via useConfig() after activation", function* () {
      const configSchema = z.object({ id: z.number() });

      const Agent = createAgent({
        name: "config-access",
        description: "Agent with config access",
        config: configSchema,
        tools: {
          noop: createTool({
            name: "noop",
            description: "No-op tool",
            input: z.object({}),
            output: z.object({}),
            progress: z.object({}),
            impl: function* () {
              return {};
            },
          }),
        },
      });

      // Activate with config
      yield* Agent({ id: 42 });

      // Config should be accessible after activation (within same scope chain)
      const config = yield* Agent.useConfig();
      expect(config.id).toBe(42);
    });
  });

  describe("agent.decorate()", () => {
    it("should apply middleware to specified tools", function* () {
      const callOrder: string[] = [];

      const Echo = createTool({
        name: "echo",
        description: "Echo",
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
        progress: z.object({}),
        impl: function* ({ value }) {
          callOrder.push("echo-impl");
          return { result: value };
        },
      });

      const Agent = createAgent({
        name: "decorated",
        description: "Decorated agent",
        tools: { echo: Echo },
      });

      yield* Agent.decorate({
        *echo(args, next) {
          callOrder.push("middleware-before");
          const result = yield* next(args);
          callOrder.push("middleware-after");
          return result;
        },
      });

      const agent = yield* Agent();
      yield* agent.echo({ value: "test" });

      expect(callOrder).toEqual([
        "middleware-before",
        "echo-impl",
        "middleware-after",
      ]);
    });

    it("should allow decorating multiple tools", function* () {
      const calls: string[] = [];

      const ToolA = createTool({
        name: "tool-a",
        description: "Tool A",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          calls.push("a");
          return {};
        },
      });

      const ToolB = createTool({
        name: "tool-b",
        description: "Tool B",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          calls.push("b");
          return {};
        },
      });

      const Agent = createAgent({
        name: "multi-tool",
        description: "Multi-tool agent",
        tools: { a: ToolA, b: ToolB },
      });

      yield* Agent.decorate({
        *a(args, next) {
          calls.push("a-middleware");
          return yield* next(args);
        },
        *b(args, next) {
          calls.push("b-middleware");
          return yield* next(args);
        },
      });

      const agent = yield* Agent();
      yield* agent.a({});
      yield* agent.b({});

      expect(calls).toEqual([
        "a-middleware",
        "a",
        "b-middleware",
        "b",
      ]);
    });
  });

  describe("agent.tools (sibling access)", () => {
    it("should allow a tool to call sibling tools via lazy reference", function* () {
      const callLog: string[] = [];

      // Define Search tool
      const Search = createTool({
        name: "search",
        description: "Search for flights",
        input: z.object({ destination: z.string() }),
        output: z.object({ flightIds: z.array(z.string()) }),
        progress: z.object({}),
        impl: function* ({ destination }) {
          callLog.push(`search:${destination}`);
          return { flightIds: [`flight-to-${destination}`] };
        },
      });

      // Define Book tool that calls Search as a sibling
      // Note: Agent is referenced before it's defined, but this works because
      // the impl function is only executed at runtime, after Agent exists
      const Book = createTool({
        name: "book",
        description: "Book a flight",
        input: z.object({ destination: z.string() }),
        output: z.object({ confirmation: z.string() }),
        progress: z.object({}),
        // Return type annotation needed to break circular type inference
        impl: function* ({ destination }): Operation<{ confirmation: string }> {
          callLog.push(`book:start:${destination}`);

          // Call sibling tool via Agent.tools
          const searchTool = yield* Agent.tools.search();
          const searchResult = yield* searchTool({ destination });

          callLog.push(`book:searched:${searchResult.flightIds.join(",")}`);
          return { confirmation: `booked:${searchResult.flightIds[0]}` };
        },
      });

      // Create the agent with both tools
      const Agent = createAgent({
        name: "travel",
        description: "Travel booking agent",
        tools: { search: Search, book: Book },
      });

      // Activate the agent
      const agent = yield* Agent();

      // Call book, which internally calls search
      const result = yield* agent.book({ destination: "Tokyo" });

      expect(result).toEqual({ confirmation: "booked:flight-to-Tokyo" });
      expect(callLog).toEqual([
        "book:start:Tokyo",
        "search:Tokyo",
        "book:searched:flight-to-Tokyo",
      ]);
    });

    it("should expose tool factories on Agent.tools", function* () {
      const Search = createTool({
        name: "search",
        description: "Search",
        input: z.object({ query: z.string() }),
        output: z.object({ results: z.array(z.string()) }),
        progress: z.object({}),
        impl: function* ({ query }) {
          return { results: [`result for: ${query}`] };
        },
      });

      const Agent = createAgent({
        name: "sibling",
        description: "Agent with sibling access",
        tools: { search: Search },
      });

      // Verify tool factories are accessible on Agent.tools
      expect(Agent.tools.search).toBe(Search);
      expect(Agent.tools.search.name).toBe("search");
    });
  });

  describe("agent with transport-routed tools", () => {
    it("should work with tools that route through transport", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      // Tool without impl - will route to transport
      const RemoteTool = createTool({
        name: "remote",
        description: "Remote tool",
        input: z.object({ value: z.number() }),
        output: z.object({ doubled: z.number() }),
      });

      const Agent = createAgent({
        name: "remote-agent",
        description: "Agent with remote tool",
        tools: { remote: RemoteTool },
      });

      // Set up operative handler
      yield* spawn(function* () {
        yield* handleOperativeRequests(operative, (request) => {
          const { value } = request.payload as { value: number };
          return { doubled: value * 2 };
        });
      });

      yield* sleep(0);

      const agent = yield* Agent();
      const result = yield* agent.remote({ value: 21 });

      expect(result).toEqual({ doubled: 42 });
    });
  });
});

/**
 * Helper function to handle operative requests.
 */
function* handleOperativeRequests(
  operative: OperativeTransport,
  handler: (request: TransportRequest) => unknown,
) {
  const sub = yield* operative;

  for (;;) {
    const result = yield* sub.next();
    if (result.done) break;

    const request = result.value as TransportRequest;

    try {
      const content = handler(request);
      const response: ResponseMessage = {
        type: "response",
        id: request.id,
        response: { status: "accepted", content },
      };
      yield* operative.send(response);
    } catch (e) {
      const response: ResponseMessage = {
        type: "response",
        id: request.id,
        response: { status: "other", content: (e as Error).message },
      };
      yield* operative.send(response);
    }
  }
}
