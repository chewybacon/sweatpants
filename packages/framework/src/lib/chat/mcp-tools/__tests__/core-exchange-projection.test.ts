import { describe, expect, it } from "vitest";
import type { ElicitExchange, SampleExchange, ToolMessage } from "@sweatpants/core";
import {
  projectCoreElicitExchangeToMcpMessages,
  projectCoreInteractionExchangeToMcpMessages,
  projectCoreExchangesToMcpMessages,
  projectCoreSampleExchangeToMcpMessages,
} from "../core-exchange-projection.ts";

function elicitExchange(context: { flightId: string }): ElicitExchange<{ flightId: string }> {
  const request: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: [{ type: "tool_use", id: "elicit:confirm", name: "confirm", input: {} }],
  };
  const response: ToolMessage & { role: "user" } = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "elicit:confirm",
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      },
    ],
  };
  return {
    context,
    request,
    response,
    messages: [request, response],
    withArguments(fn) {
      const args = fn(context);
      return [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "elicit:confirm", name: "confirm", input: args }],
        },
        response,
      ];
    },
  };
}

function sampleExchange(): SampleExchange {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "Summarize this" }] },
      { role: "assistant", content: [{ type: "text", text: "Summary" }] },
    ],
  };
}

describe("core exchange to MCP projection", () => {
  it("projects elicit exchanges directly from the message pair", () => {
    const exchange = elicitExchange({ flightId: "FL001" });
    const messages = projectCoreElicitExchangeToMcpMessages(exchange);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_use", id: "elicit:confirm", name: "confirm" }],
    });
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "elicit:confirm" }],
    });
    // projection must not mutate the exchange
    expect(exchange.context).toEqual({ flightId: "FL001" });
  });

  it("projects sample exchanges", () => {
    const messages = projectCoreSampleExchangeToMcpMessages(sampleExchange());
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Summarize this" }] },
      { role: "assistant", content: [{ type: "text", text: "Summary" }] },
    ]);
  });

  it("projects mixed exchange arrays via the interaction discriminator", () => {
    const elicit = elicitExchange({ flightId: "FL001" });
    const sample = sampleExchange();
    expect(projectCoreInteractionExchangeToMcpMessages(elicit)).toHaveLength(2);
    expect(projectCoreExchangesToMcpMessages([elicit, sample])).toHaveLength(4);
  });
});
