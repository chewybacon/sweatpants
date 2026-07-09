import type { ElicitExchange, SampleExchange } from "@sweatpants/core";
import type { McpMessage } from "./protocol/types.ts";

type CoreExchange = ElicitExchange<unknown> | SampleExchange;

/**
 * Project an elicit exchange into MCP transcript messages.
 * Exchanges are constructed in the message-pair shape by the runtimes,
 * so projection is a direct read of `messages`.
 */
export function projectCoreElicitExchangeToMcpMessages(
  exchange: ElicitExchange<unknown>,
): McpMessage[] {
  return exchange.messages as McpMessage[];
}

/**
 * Project a sample exchange into MCP transcript messages.
 */
export function projectCoreSampleExchangeToMcpMessages(exchange: SampleExchange): McpMessage[] {
  return exchange.messages as McpMessage[];
}

function isElicitExchange(exchange: CoreExchange): exchange is ElicitExchange<unknown> {
  return (
    "withArguments" in exchange &&
    typeof (exchange as ElicitExchange<unknown>).withArguments === "function"
  );
}

export function projectCoreInteractionExchangeToMcpMessages(exchange: CoreExchange): McpMessage[] {
  return isElicitExchange(exchange)
    ? projectCoreElicitExchangeToMcpMessages(exchange)
    : projectCoreSampleExchangeToMcpMessages(exchange as SampleExchange);
}

export function projectCoreExchangesToMcpMessages(
  exchanges: readonly CoreExchange[],
): McpMessage[] {
  return exchanges.flatMap(projectCoreInteractionExchangeToMcpMessages);
}
