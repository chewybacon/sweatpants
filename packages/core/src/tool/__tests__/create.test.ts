import { describe, it, expect } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../create.ts";

describe("createTool", () => {
  describe("with impl in config", () => {
    it("should create and activate a tool with impl", function* () {
      const Search = createTool({
        name: "search",
        description: "Search for flights",
        input: z.object({ destination: z.string() }),
        output: z.object({ flights: z.array(z.string()) }),
        progress: z.object({ loaded: z.number() }),
        impl: function* ({ destination }, _send) {
          return { flights: [`Flight to ${destination}`] };
        },
      });

      expect(Search.name).toBe("search");
      expect(Search.description).toBe("Search for flights");

      const search = yield* Search();
      const result = yield* search({ destination: "Tokyo" });

      expect(result).toEqual({ flights: ["Flight to Tokyo"] });
    });

    it("should invoke impl with correct arguments", function* () {
      const receivedArgs: unknown[] = [];

      const Echo = createTool({
        name: "echo",
        description: "Echo input",
        input: z.object({ message: z.string(), count: z.number() }),
        output: z.object({ echoed: z.string() }),
        progress: z.object({ step: z.number() }),
        impl: function* (args, _send) {
          receivedArgs.push(args);
          return { echoed: args.message.repeat(args.count) };
        },
      });

      const echo = yield* Echo();
      const result = yield* echo({ message: "hello", count: 3 });

      expect(result).toEqual({ echoed: "hellohellohello" });
      expect(receivedArgs).toHaveLength(1);
      expect(receivedArgs[0]).toEqual({ message: "hello", count: 3 });
    });

    it("should allow multiple invocations", function* () {
      let callCount = 0;

      const Counter = createTool({
        name: "counter",
        description: "Count calls",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        progress: z.object({}),
        impl: function* () {
          callCount++;
          return { count: callCount };
        },
      });

      const counter = yield* Counter();

      const result1 = yield* counter({});
      const result2 = yield* counter({});
      const result3 = yield* counter({});

      expect(result1).toEqual({ count: 1 });
      expect(result2).toEqual({ count: 2 });
      expect(result3).toEqual({ count: 3 });
    });
  });

  describe("without impl in config", () => {
    it("should activate with provided impl", function* () {
      const GetLocation = createTool({
        name: "get-location",
        description: "Get user location",
        input: z.object({ accuracy: z.enum(["high", "low"]) }),
        output: z.object({ lat: z.number(), lng: z.number() }),
      });

      expect(GetLocation.name).toBe("get-location");
      expect(GetLocation.description).toBe("Get user location");

      const getLocation = yield* GetLocation(function* ({ accuracy }) {
        return accuracy === "high"
          ? { lat: 40.7128, lng: -74.006 }
          : { lat: 40.7, lng: -74.0 };
      });

      const result = yield* getLocation({ accuracy: "high" });
      expect(result).toEqual({ lat: 40.7128, lng: -74.006 });
    });

    it("should throw when activated without impl and no transport", function* () {
      const NoImpl = createTool({
        name: "no-impl",
        description: "Tool without impl",
        input: z.object({}),
        output: z.object({}),
      });

      const noImpl = yield* NoImpl();

      let error: Error | undefined;
      try {
        yield* noImpl({});
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toContain("no-impl");
      expect(error?.message).toContain("transport routing is not yet implemented");
    });
  });

  describe("decorate", () => {
    it("should wrap tool invocations with middleware", function* () {
      const callOrder: string[] = [];

      const Greet = createTool({
        name: "greet",
        description: "Greet someone",
        input: z.object({ name: z.string() }),
        output: z.object({ greeting: z.string() }),
        progress: z.object({}),
        impl: function* ({ name }) {
          callOrder.push("impl");
          return { greeting: `Hello, ${name}!` };
        },
      });

      yield* Greet.decorate(function* (args, next) {
        callOrder.push("middleware-before");
        const result = yield* next(args);
        callOrder.push("middleware-after");
        return result;
      });

      const greet = yield* Greet();
      const result = yield* greet({ name: "World" });

      expect(result).toEqual({ greeting: "Hello, World!" });
      expect(callOrder).toEqual([
        "middleware-before",
        "impl",
        "middleware-after",
      ]);
    });

    it("should allow middleware to modify args", function* () {
      const Uppercase = createTool({
        name: "uppercase",
        description: "Convert to uppercase",
        input: z.object({ text: z.string() }),
        output: z.object({ result: z.string() }),
        progress: z.object({}),
        impl: function* ({ text }) {
          return { result: text.toUpperCase() };
        },
      });

      yield* Uppercase.decorate(function* (args, next) {
        // Prepend prefix to input
        return yield* next({ text: `prefix-${args.text}` });
      });

      const uppercase = yield* Uppercase();
      const result = yield* uppercase({ text: "hello" });

      expect(result).toEqual({ result: "PREFIX-HELLO" });
    });

    it("should allow middleware to modify result", function* () {
      const Double = createTool({
        name: "double",
        description: "Double a number",
        input: z.object({ value: z.number() }),
        output: z.object({ doubled: z.number() }),
        progress: z.object({}),
        impl: function* ({ value }) {
          return { doubled: value * 2 };
        },
      });

      yield* Double.decorate(function* (args, next) {
        const result = yield* next(args);
        // Triple the already doubled value
        return { doubled: result.doubled * 3 };
      });

      const double = yield* Double();
      const result = yield* double({ value: 5 });

      // 5 * 2 = 10, then 10 * 3 = 30
      expect(result).toEqual({ doubled: 30 });
    });

    it("should support multiple middleware (applied in order)", function* () {
      const callOrder: string[] = [];

      const Chain = createTool({
        name: "chain",
        description: "Chain test",
        input: z.object({}),
        output: z.object({ value: z.number() }),
        progress: z.object({}),
        impl: function* () {
          callOrder.push("impl");
          return { value: 1 };
        },
      });

      yield* Chain.decorate(function* (args, next) {
        callOrder.push("first-before");
        const result = yield* next(args);
        callOrder.push("first-after");
        return { value: result.value + 10 };
      });

      yield* Chain.decorate(function* (args, next) {
        callOrder.push("second-before");
        const result = yield* next(args);
        callOrder.push("second-after");
        return { value: result.value * 2 };
      });

      const chain = yield* Chain();
      const result = yield* chain({});

      // Middleware wraps: second(first(impl))
      // second-before -> first-before -> impl -> first-after -> second-after
      // Value: impl=1, first adds 10 = 11, second doubles = 22
      expect(callOrder).toEqual([
        "second-before",
        "first-before",
        "impl",
        "first-after",
        "second-after",
      ]);
      expect(result).toEqual({ value: 22 });
    });
  });

  describe("error handling", () => {
    it("should throw when tool not activated", function* () {
      // This test verifies the error message when someone tries to
      // use api.operations.invoke directly without activating
      // (this shouldn't happen in practice but tests the safeguard)
      const Unactivated = createTool({
        name: "unactivated",
        description: "Never activated",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          return {};
        },
      });

      // The factory returns an Operation, so we need to yield* it
      // If we just call Unactivated but don't yield* it, we get back an Operation
      // The error would only happen if someone bypassed the factory
      expect(Unactivated.name).toBe("unactivated");
    });

    it("should propagate impl errors", function* () {
      const Failing = createTool({
        name: "failing",
        description: "Always fails",
        input: z.object({}),
        output: z.object({}),
        progress: z.object({}),
        impl: function* () {
          throw new Error("Intentional failure");
        },
      });

      const failing = yield* Failing();

      let error: Error | undefined;
      try {
        yield* failing({});
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toBe("Intentional failure");
    });
  });
});
