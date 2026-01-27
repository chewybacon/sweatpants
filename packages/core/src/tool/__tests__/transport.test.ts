import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep } from "effection";
import { z } from "zod";
import { createTool } from "../create.ts";
import { createTransportPair } from "../../transport/pair.ts";
import { createCorrelation } from "../../transport/correlation.ts";
import { TransportContext } from "../../context/transport.ts";
import type {
  TransportRequest,
  OperativeTransport,
  ResponseMessage,
  ProgressMessage,
} from "../../types/transport.ts";

describe("createTool with transport", () => {
  it("should route tool invocation through transport when no impl provided", function* () {
    // Create transport pair
    const [principal, operative] = yield* createTransportPair();

    // Create correlated transport for Principal
    const correlated = yield* createCorrelation(principal);

    // Set up TransportContext
    yield* TransportContext.set(correlated);

    // Define tool without impl (will route to transport)
    const GetLocation = createTool({
      name: "get-location",
      description: "Get user location",
      input: z.object({ accuracy: z.enum(["high", "low"]) }),
      output: z.object({ lat: z.number(), lng: z.number() }),
    });

    // Activate tool (no impl - routes to transport)
    const getLocation = yield* GetLocation();

    // Set up Operative handler that responds to requests
    yield* spawn(function* () {
      yield* handleOperativeRequests(operative, (request) => {
        if (request.type === "get-location") {
          const payload = request.payload as { accuracy: string };
          if (payload.accuracy === "high") {
            return { lat: 40.7128, lng: -74.006 };
          }
          return { lat: 40.7, lng: -74.0 };
        }
        throw new Error(`Unknown tool: ${request.type}`);
      });
    });

    // Give operative handler time to start
    yield* sleep(0);

    // Invoke tool - should route through transport
    const result = yield* getLocation({ accuracy: "high" });

    expect(result).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it("should handle multiple tool invocations", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);
    yield* TransportContext.set(correlated);

    const Calculator = createTool({
      name: "calculator",
      description: "Perform calculations",
      input: z.object({ a: z.number(), b: z.number(), op: z.enum(["+", "-", "*", "/"]) }),
      output: z.object({ result: z.number() }),
    });

    const calculator = yield* Calculator();

    // Set up Operative handler
    yield* spawn(function* () {
      yield* handleOperativeRequests(operative, (request) => {
        const { a, b, op } = request.payload as { a: number; b: number; op: string };
        let result: number;
        switch (op) {
          case "+": result = a + b; break;
          case "-": result = a - b; break;
          case "*": result = a * b; break;
          case "/": result = a / b; break;
          default: throw new Error(`Unknown operation: ${op}`);
        }
        return { result };
      });
    });

    yield* sleep(0);

    const sum = yield* calculator({ a: 5, b: 3, op: "+" });
    expect(sum).toEqual({ result: 8 });

    const product = yield* calculator({ a: 5, b: 3, op: "*" });
    expect(product).toEqual({ result: 15 });

    const quotient = yield* calculator({ a: 10, b: 2, op: "/" });
    expect(quotient).toEqual({ result: 5 });
  });

  it("should handle declined response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);
    yield* TransportContext.set(correlated);

    const RestrictedTool = createTool({
      name: "restricted",
      description: "A restricted operation",
      input: z.object({}),
      output: z.object({}),
    });

    const restricted = yield* RestrictedTool();

    // Set up Operative handler that declines all requests
    yield* spawn(function* () {
      const sub = yield* operative;
      const result = yield* sub.next();
      if (!result.done) {
        const request = result.value as TransportRequest;
        const response: ResponseMessage = {
          type: "response",
          id: request.id,
          response: { status: "declined" },
        };
        yield* operative.send(response);
      }
    });

    yield* sleep(0);

    let error: Error | undefined;
    try {
      yield* restricted({});
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("declined");
  });

  it("should handle cancelled response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);
    yield* TransportContext.set(correlated);

    const CancellableTool = createTool({
      name: "cancellable",
      description: "A cancellable operation",
      input: z.object({}),
      output: z.object({}),
    });

    const cancellable = yield* CancellableTool();

    // Set up Operative handler that cancels all requests
    yield* spawn(function* () {
      const sub = yield* operative;
      const result = yield* sub.next();
      if (!result.done) {
        const request = result.value as TransportRequest;
        const response: ResponseMessage = {
          type: "response",
          id: request.id,
          response: { status: "cancelled" },
        };
        yield* operative.send(response);
      }
    });

    yield* sleep(0);

    let error: Error | undefined;
    try {
      yield* cancellable({});
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("cancelled");
  });

  it("should throw when TransportContext is not set", function* () {
    // Note: TransportContext is NOT set in this test

    const NoTransport = createTool({
      name: "no-transport",
      description: "Tool without transport",
      input: z.object({}),
      output: z.object({}),
    });

    const noTransport = yield* NoTransport();

    let error: Error | undefined;
    try {
      yield* noTransport({});
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("sweatpants.transport");
  });

  it("should receive progress updates from operative", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated = yield* createCorrelation(principal);
    yield* TransportContext.set(correlated);

    const LongRunning = createTool({
      name: "long-running",
      description: "A long running operation",
      input: z.object({ steps: z.number() }),
      progress: z.object({ step: z.number(), total: z.number() }),
      output: z.object({ completed: z.boolean() }),
    });

    const longRunning = yield* LongRunning();

    // Set up Operative handler that sends progress updates
    yield* spawn(function* () {
      const sub = yield* operative;
      const result = yield* sub.next();
      if (!result.done) {
        const request = result.value as TransportRequest;
        const { steps } = request.payload as { steps: number };

        // Send progress updates
        for (let i = 1; i <= steps; i++) {
          const progress: ProgressMessage = {
            type: "progress",
            id: request.id,
            data: { step: i, total: steps },
          };
          yield* operative.send(progress);
          yield* sleep(1);
        }

        // Send final response
        const response: ResponseMessage = {
          type: "response",
          id: request.id,
          response: { status: "accepted", content: { completed: true } },
        };
        yield* operative.send(response);
      }
    });

    yield* sleep(0);

    // Currently progress is ignored, but tool should still complete
    const result = yield* longRunning({ steps: 3 });
    expect(result).toEqual({ completed: true });
  });
});

/**
 * Helper function to handle operative requests.
 * Listens for requests and sends back responses.
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
