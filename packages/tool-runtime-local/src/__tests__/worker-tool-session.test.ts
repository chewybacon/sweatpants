// @vitest-environment node
import { run, type Operation } from "effection";
import { expect, it } from "vitest";
import type { ToolSessionEvent } from "@sweatpants/tool-session";
import { createWorkerToolSession } from "../worker-tool-session.ts";

const workerUrl = new URL("./fixtures/tool-worker-bootstrap.mjs", import.meta.url);

type EventReader = {
  next(): Operation<IteratorResult<ToolSessionEvent, void>>;
};

/** Await the next protocol event directly; never poll worker state. */
function* nextEvent<T extends ToolSessionEvent["type"]>(
  reader: EventReader,
  type: T,
): Operation<Extract<ToolSessionEvent, { type: T }>> {
  const next = yield* reader.next();
  if (next.done || next.value.type !== type) {
    throw new Error(`Expected ${type}, received ${JSON.stringify(next)}`);
  }
  return next.value as Extract<ToolSessionEvent, { type: T }>;
}

function openSession(toolName: string, params = {}) {
  return createWorkerToolSession({
    sessionId: crypto.randomUUID(),
    toolName,
    params,
    workerUrl,
    execArgv: ["--conditions=production"],
  });
}

it("reports a missing tool from the worker as a failed session", async () => {
  await run(function* () {
    // Arrange
    const session = yield* openSession("missing_tool");
    const reader = yield* session.projection.events();

    // Act
    const failure = yield* nextEvent(reader, "error");

    // Assert: this is remote registry lookup, not host inventory validation.
    expect(failure.message).toContain("Tool not found");
    expect(yield* session.status()).toBe("failed");
  });
});

it("exchanges sample metadata and a typed elicitation on the same worker", async () => {
  await run(function* () {
    // Arrange
    const session = yield* openSession("sample_with_options");
    const reader = yield* session.projection.events();

    // Act / Assert: inspect the actual request crossing the worker boundary.
    const sample = yield* nextEvent(reader, "sample_request");
    expect(yield* session.status()).toBe("awaiting_sample");
    expect(sample).toMatchObject({
      systemPrompt: "You are a helpful assistant",
      maxTokens: 100,
      modelPreferences: {
        hints: [{ name: "claude-3-5-sonnet" }],
        intelligencePriority: 0.8,
        speedPriority: 0.2,
      },
    });
    yield* session.resume({
      kind: "sample",
      requestId: sample.sampleId,
      response: { text: "Hello there!", model: "test-model", stopReason: "endTurn" },
    });

    // Act / Assert: sample completion can park the same generator on an elicit.
    const choice = yield* nextEvent(reader, "elicit_request");
    expect(yield* session.status()).toBe("awaiting_elicit");
    expect(choice.key).toBe("chooseFlight");
    expect(choice.schema).toEqual({
      type: "object",
      properties: { flightId: { type: "string" } },
      required: ["flightId"],
    });
    expect(choice.context).toEqual({
      flights: [
        { id: "FL001", airline: "SkyHigh", price: 299 },
        { id: "FL002", airline: "CloudAir", price: 349 },
      ],
      totalOptions: 2,
    });
    yield* session.resume({
      kind: "elicit",
      requestId: choice.elicitId,
      response: { action: "accept", content: { flightId: "FL001" } },
    });

    // Assert
    expect((yield* nextEvent(reader, "result")).result).toEqual({
      text: "Hello there!",
      model: "test-model",
      selectedFlightId: "FL001",
    });
    expect(yield* session.status()).toBe("completed");
  });
});

it("exchanges a structured sample projection and its parsed reply", async () => {
  await run(function* () {
    // Arrange
    const session = yield* openSession("sample_with_parsed");
    const reader = yield* session.projection.events();

    // Act / Assert
    const sample = yield* nextEvent(reader, "sample_request");
    expect(sample.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
    yield* session.resume({
      kind: "sample",
      requestId: sample.sampleId,
      response: {
        text: '{"name": "Alice", "age": 30}',
        model: "test-model",
        stopReason: "endTurn",
        parsed: { name: "Alice", age: 30 },
      },
    });

    expect((yield* nextEvent(reader, "result")).result).toEqual({
      text: '{"name": "Alice", "age": 30}',
      parsed: { name: "Alice", age: 30 },
    });
    expect(yield* session.status()).toBe("completed");
  });
});

it("exchanges sample tool definitions, choice policy and returned calls", async () => {
  await run(function* () {
    // Arrange
    const session = yield* openSession("sample_with_tools");
    const reader = yield* session.projection.events();
    const calls = [
      {
        id: "call-123",
        name: "get_weather",
        input: { location: "New York" },
        thoughtSignature: null,
      },
    ];

    // Act / Assert
    const sample = yield* nextEvent(reader, "sample_request");
    expect(sample.tools).toEqual([
      {
        name: "get_weather",
        description: "Get the current weather",
        inputSchema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    ]);
    expect(sample.toolChoice).toEqual({ type: "auto" });
    yield* session.resume({
      kind: "sample",
      requestId: sample.sampleId,
      response: { text: "", model: "test-model", stopReason: "toolUse", toolCalls: calls },
    });

    expect((yield* nextEvent(reader, "result")).result).toEqual({ text: "", toolCalls: calls });
    expect(yield* session.status()).toBe("completed");
  });
});

it("correlates sequential samples and replays exactly the events after its cursor", async () => {
  await run(function* () {
    // Arrange
    const session = yield* openSession("multi_sample", { count: 3 });
    const reader = yield* session.projection.events();
    const samples: string[] = [];
    const events: ToolSessionEvent[] = [];

    // Act: answer three successive requests on one real worker.
    for (const text of ["Response 1", "Response 2", "Response 3"]) {
      const sample = yield* nextEvent(reader, "sample_request");
      events.push(sample);
      samples.push(sample.sampleId);
      yield* session.resume({
        kind: "sample",
        requestId: sample.sampleId,
        response: { text, model: "test-model", stopReason: "endTurn" },
      });
    }
    const result = yield* nextEvent(reader, "result");
    events.push(result);

    // Assert: correlation and exact replay, rather than a timed partial collection.
    expect(new Set(samples).size).toBe(3);
    expect(result.result).toEqual({ responses: ["Response 1", "Response 2", "Response 3"] });
    expect(events.map((event) => event.lsn)).toEqual([1, 2, 3, 4]);
    const replay = yield* session.projection.events(2);
    expect((yield* replay.next()).value).toEqual(events[2]);
    expect((yield* replay.next()).value).toEqual(events[3]);
    expect((yield* replay.next()).done).toBe(true);
    expect(yield* session.status()).toBe("completed");
  });
});
