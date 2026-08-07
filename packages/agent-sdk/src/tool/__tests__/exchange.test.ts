import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  completeElicitExchange,
  completeSampleExchange,
  parseElicitExchangeCompletion,
} from "../exchange.ts";

const responseSchema = z.object({
  answer: z.string().trim(),
  confirmed: z.boolean().default(true),
});

describe("authored elicitation exchange completion", () => {
  it("validates once and carries transformed output into the canonical exchange", async () => {
    const context = { choices: ["yes", "no"] };
    const result = await run(function* () {
      return yield* completeElicitExchange({
        key: "confirm",
        message: "Confirm this choice",
        context,
        exchangeId: "elicit:call-1:1",
        responseSchema,
        completion: { action: "accept", content: { answer: "  yes  " } },
      });
    });

    expect(result.action).toBe("accept");
    if (result.action !== "accept") throw new Error("expected accepted elicitation");
    expect(result.content).toEqual({ answer: "yes", confirmed: true });
    expect(result.exchange.context).toBe(context);
    expect(result.exchange.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Confirm this choice" },
          {
            type: "tool-call",
            toolCall: {
              id: "elicit:call-1:1",
              name: "confirm",
              input: {},
              thoughtSignature: null,
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "elicit:call-1:1",
        name: "confirm",
        content: [{ type: "text", text: '{"answer":"yes","confirmed":true}' }],
        isError: false,
      },
    ]);
    expect(
      result.exchange.withArguments((value) => ({ choice: value.choices[0] ?? null }))[0],
    ).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Confirm this choice" },
        {
          type: "tool-call",
          toolCall: {
            id: "elicit:call-1:1",
            name: "confirm",
            input: { choice: "yes" },
            thoughtSignature: null,
          },
        },
      ],
    });
  });

  it("rejects malformed accepted content before constructing history", async () => {
    await expect(
      run(function* () {
        return yield* completeElicitExchange({
          key: "confirm",
          message: "Confirm",
          context: undefined,
          exchangeId: "elicit:call-1:2",
          responseSchema,
          completion: { action: "accept", content: { answer: 42 } },
        });
      }),
    ).rejects.toThrow('Elicit response validation failed for key "confirm"');
  });

  it("passes decline and cancel without invoking the accepted-content schema", async () => {
    let validations = 0;
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate() {
          validations += 1;
          return { value: "unused" };
        },
      },
    };

    const decline = await run(function* () {
      return yield* completeElicitExchange({
        key: "confirm",
        message: "Confirm",
        context: undefined,
        exchangeId: "elicit:call-1:3",
        responseSchema: schema,
        completion: { action: "decline", reason: "not now" },
      });
    });
    const cancel = await run(function* () {
      return yield* completeElicitExchange({
        key: "confirm",
        message: "Confirm",
        context: undefined,
        exchangeId: "elicit:call-1:4",
        responseSchema: schema,
        completion: { action: "cancel" },
      });
    });

    expect(decline).toEqual({ action: "decline", reason: "not now" });
    expect(cancel).toEqual({ action: "cancel" });
    expect(validations).toBe(0);
  });

  it("completes sample history from transport-safe response facts", () => {
    expect(
      completeSampleExchange({
        promptText: "Summarize",
        completion: { text: "Done", model: "test-model" },
      }),
    ).toMatchObject({
      text: "Done",
      exchange: { messages: [{ role: "user" }, { role: "assistant" }] },
    });

    expect(
      completeSampleExchange({
        promptText: "Choose",
        exchangeId: "sample:call-1:1",
        completion: { text: "", parsed: { choice: "a" } },
      }),
    ).toMatchObject({
      parsed: { choice: "a" },
      exchange: {
        parsed: { choice: "a" },
        messages: [
          { role: "user" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCall: { id: "sample:call-1:1", name: "__schema__" },
              },
            ],
          },
          { role: "tool" },
        ],
      },
    });
  });

  it("restores only closed JSON completion payloads", () => {
    expect(parseElicitExchangeCompletion({ action: "accept", content: { ok: true } })).toEqual({
      action: "accept",
      content: { ok: true },
    });
    expect(() =>
      parseElicitExchangeCompletion({ action: "accept", content: { ok: true }, extra: true }),
    ).toThrow();
    expect(() => parseElicitExchangeCompletion({ action: "accept" })).toThrow();
  });
});
