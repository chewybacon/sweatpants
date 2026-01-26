import { describe, it, expect } from "@effectionx/vitest";
import { createContext } from "effection";
import { z } from "zod";
import { createTool } from "../create.ts";
import { createAgent } from "../../agent/create.ts";

describe("Tool.withContext()", () => {
  describe("single context binding", () => {
    it("should provide context value during tool invocation", function* () {
      const TestContext = createContext<string>("test-context");
      let capturedValue: string | undefined;

      const Tool = createTool({
        name: "context-reader",
        description: "Reads from context",
        input: z.object({}),
        output: z.object({ value: z.string() }),
        progress: z.object({}),
        impl: function* () {
          capturedValue = yield* TestContext.expect();
          return { value: capturedValue };
        },
      });

      // Apply context binding
      const BoundTool = Tool.withContext(TestContext, "hello-from-context");

      // Activate and invoke
      const tool = yield* BoundTool();
      const result = yield* tool({});

      expect(result.value).toBe("hello-from-context");
      expect(capturedValue).toBe("hello-from-context");
    });

    it("should not leak context outside of invocation", function* () {
      const TestContext = createContext<string>("leak-test");

      const Tool = createTool({
        name: "context-tool",
        description: "Tool with context",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          return {};
        },
      });

      const BoundTool = Tool.withContext(TestContext, "scoped-value");
      const tool = yield* BoundTool();
      yield* tool({});

      // Context should not be set outside the tool invocation
      const outsideValue = yield* TestContext.get();
      expect(outsideValue).toBeUndefined();
    });
  });

  describe("chained context bindings", () => {
    it("should apply multiple contexts with first as outermost", function* () {
      const OuterContext = createContext<string>("outer");
      const InnerContext = createContext<string>("inner");
      let capturedOuter: string | undefined;
      let capturedInner: string | undefined;

      const Tool = createTool({
        name: "multi-context",
        description: "Reads multiple contexts",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          capturedOuter = yield* OuterContext.expect();
          capturedInner = yield* InnerContext.expect();
          return {};
        },
      });

      // Chain: OuterContext wraps InnerContext
      const BoundTool = Tool
        .withContext(OuterContext, "outer-value")
        .withContext(InnerContext, "inner-value");

      const tool = yield* BoundTool();
      yield* tool({});

      expect(capturedOuter).toBe("outer-value");
      expect(capturedInner).toBe("inner-value");
    });

    it("should allow same context to be bound twice (inner wins)", function* () {
      const TestContext = createContext<string>("double-bind");
      let capturedValue: string | undefined;

      const Tool = createTool({
        name: "double-context",
        description: "Reads context",
        input: z.object({}),
        output: z.object({ value: z.string() }),
        progress: z.object({}),
        impl: function* () {
          capturedValue = yield* TestContext.expect();
          return { value: capturedValue };
        },
      });

      // Same context bound twice - inner should win
      const BoundTool = Tool
        .withContext(TestContext, "outer-value")
        .withContext(TestContext, "inner-value");

      const tool = yield* BoundTool();
      const result = yield* tool({});

      // Inner binding wins because it's closer to the invocation
      expect(result.value).toBe("inner-value");
    });
  });

  describe("with transport context", () => {
    it("should work with TransportContext for routing", function* () {
      // This is the primary use case - routing tools to different transports
      const TransportContext = createContext<{ name: string }>("transport");
      let capturedTransport: { name: string } | undefined;

      const Tool = createTool({
        name: "routed-tool",
        description: "Tool that checks transport",
        input: z.object({}),
        output: z.object({ transport: z.string() }),
        progress: z.object({}),
        impl: function* () {
          capturedTransport = yield* TransportContext.expect();
          return { transport: capturedTransport.name };
        },
      });

      const StdioTool = Tool.withContext(TransportContext, { name: "stdio" });
      const SseTool = Tool.withContext(TransportContext, { name: "sse" });

      const stdioInstance = yield* StdioTool();
      const sseInstance = yield* SseTool();

      const stdioResult = yield* stdioInstance({});
      const sseResult = yield* sseInstance({});

      expect(stdioResult.transport).toBe("stdio");
      expect(sseResult.transport).toBe("sse");
    });
  });

  describe("with agent integration", () => {
    it("should work when tool with context is used in agent", function* () {
      const ConfigContext = createContext<{ apiKey: string }>("config");
      let capturedKey: string | undefined;

      const ApiTool = createTool({
        name: "api-call",
        description: "Makes API call",
        input: z.object({}),
        output: z.object({ key: z.string() }),
        progress: z.object({}),
        impl: function* () {
          const config = yield* ConfigContext.expect();
          capturedKey = config.apiKey;
          return { key: config.apiKey };
        },
      });

      const Agent = createAgent({
        name: "api-agent",
        description: "Agent with configured tool",
        tools: {
          // Tool with context binding used in agent
          apiCall: ApiTool.withContext(ConfigContext, { apiKey: "sk-test-123" }),
        },
      });

      const agent = yield* Agent();
      const result = yield* agent.apiCall({});

      expect(result.key).toBe("sk-test-123");
      expect(capturedKey).toBe("sk-test-123");
    });
  });
});
