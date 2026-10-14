import { describe, expect, it } from "vitest";
import { run } from "effection";
import { createTisynTool, parseProgram, validateProgram } from "../tisyn.ts";
import { sampleCompletion, samplingParameters } from "../sampling.ts";

describe("Tisyn sampling capability", () => {
  it("returns actionable preflight diagnostics without executing effects", async () => {
    const tool = createTisynTool([]).samples().build();
    const context = new Proxy(
      {},
      {
        get() {
          throw new Error("Preflight accessed execution context");
        },
      },
    );
    const result = await run(() =>
      tool.program(
        { program: 'Eval("sample", {"prompt":"a color"})', validateOnly: true },
        context as Parameters<typeof tool.program>[1],
      ),
    );
    expect(result).toEqual({ status: "valid", executed: false });
    expect(validateProgram('Let("x",1)', [])).toEqual({
      status: "invalid",
      executed: false,
      diagnostic: expect.stringContaining("Let"),
    });
    expect(validateProgram('Eval("shell",{})', [])).toEqual({
      status: "invalid",
      executed: false,
      diagnostic: expect.stringContaining("Unsupported"),
    });
  });

  it("opts into native sampling without installing a child tool", () => {
    const disabled = createTisynTool([]).build();
    const direct = createTisynTool([]).samples().build();
    expect(disabled.manifest.pulls?.sample).toBeUndefined();
    expect(direct.manifest.pulls?.sample).toBeDefined();
    expect(new Set([disabled, direct].map((tool) => tool.manifest.digest)).size).toBe(2);
  });

  it("admits sampling only when declared", () => {
    const source = 'Eval("sample",{"prompt":"Return a color"})';
    expect(() => parseProgram(source, [])).toThrow("Unsupported");
    expect(parseProgram(source, [], true)).toBeDefined();
  });

  it("forwards authored instructions without adding task context", async () => {
    const requests: unknown[] = [];
    const result = await run(() =>
      sampleCompletion(
        { prompt: "Return a color" },
        {
          *sample(request) {
            requests.push(request);
            return { text: "blue" };
          },
        },
      ),
    );
    expect(requests).toEqual([{ prompt: "Return a color", maxTokens: 4096 }]);
    expect(result).toEqual({
      status: "ok",
      text: "blue",
      exchange: {
        messages: [
          { role: "user", content: [{ type: "text", text: "Return a color" }] },
          { role: "assistant", content: [{ type: "text", text: "blue" }] },
        ],
      },
    });
  });

  it.each([16, 256, 4096])("preserves an explicit generation budget of %i", async (maxTokens) => {
    const requests: unknown[] = [];
    await run(() =>
      sampleCompletion(
        { prompt: "Return a color", maxTokens },
        {
          *sample(request) {
            requests.push(request);
            return { text: "blue" };
          },
        },
      ),
    );
    expect(requests).toEqual([{ prompt: "Return a color", maxTokens }]);
  });

  it("bounds sampling inputs", () => {
    expect(samplingParameters.safeParse({ prompt: "", maxTokens: 1 }).success).toBe(false);
    expect(samplingParameters.safeParse({ prompt: "hello", maxTokens: 4097 }).success).toBe(false);
    expect(samplingParameters.safeParse({ prompt: "x".repeat(32_769) }).success).toBe(false);
    expect(samplingParameters.safeParse({ prompt: "hello", maxTokens: 4096 }).success).toBe(true);
  });
});

it("returns a structured exchange with validated null and forwards prior messages", async () => {
  const requests: unknown[] = [];
  const result = await run(() =>
    sampleCompletion(
      {
        prompt: "Return null",
        exchanges: [
          {
            messages: [
              { role: "user", content: "Earlier question" },
              { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
            ],
          },
        ],
        schema: { type: "null" },
      },
      {
        *sample() {
          throw new Error("Unexpected text sample");
        },
        *sampleSchema(request) {
          requests.push(request);
          return { text: "null", parsed: request.schema.parse(null) };
        },
      },
      "sample-null",
    ),
  );
  expect(requests).toMatchObject([
    {
      messages: [{ role: "user" }, { role: "assistant" }, { role: "user", content: "Return null" }],
      maxTokens: 4096,
    },
  ]);
  expect(requests[0]).not.toHaveProperty("thinking");
  expect(result).toMatchObject({
    status: "ok",
    parsed: null,
    exchange: {
      messages: [
        { role: "user" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCall: { id: "sample-null", name: "__schema__" } }],
        },
        { role: "tool", toolCallId: "sample-null" },
      ],
    },
  });
});

it("exposes structured validation failure for repair and propagates provider errors", async () => {
  const invalid = await run(() =>
    sampleCompletion(
      { prompt: "Interpret", schema: { type: "string" } },
      {
        *sample() {
          throw new Error("Unexpected text sample");
        },
        *sampleSchema() {
          throw Object.assign(new Error("Expected string"), { code: "schema_validation_failed" });
        },
      },
      "sample-invalid",
    ),
  );
  expect(invalid).toEqual({
    status: "invalid",
    text: "",
    parseError: { message: "Expected string" },
  });
  await expect(
    run(() =>
      sampleCompletion(
        { prompt: "Interpret", schema: { type: "string" } },
        {
          *sample() {
            throw new Error("Unexpected text sample");
          },
          *sampleSchema() {
            throw new Error("Provider unavailable");
          },
        },
        "sample-error",
      ),
    ),
  ).rejects.toThrow("Provider unavailable");
});

it.each([undefined, "off", "medium"] as const)(
  "forwards thinking %s consistently for text and structured sampling",
  async (thinking) => {
    for (const schema of [undefined, { type: "string" }]) {
      const requests: unknown[] = [];
      await run(() =>
        sampleCompletion(
          { prompt: "A color", thinking, schema },
          {
            *sample(request) {
              requests.push(request);
              return { text: "blue" };
            },
            *sampleSchema(request) {
              requests.push(request);
              return { text: '\"blue\"', parsed: request.schema.parse("blue") };
            },
          },
          "thinking-check",
        ),
      );
      if (thinking === undefined) expect(requests[0]).not.toHaveProperty("thinking");
      else expect(requests[0]).toHaveProperty("thinking", thinking);
    }
  },
);
