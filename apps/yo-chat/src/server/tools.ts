import type { Operation } from "effection";
import { resolvePersona } from "@sweatpants/chat-core";
import {
  MaxIterationsContext,
  McpToolRegistryContext,
  PersonaResolverContext,
} from "@sweatpants/durable-chat-runtime/contexts";
import type { McpToolRegistry } from "@sweatpants/chat-core";
import { workerTools } from "./worker-tools";
import { bookFlightTool } from "../tools/book-flight/tool";
import { askQuestion } from "../tools/general/ask-question/tool";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";
import { tictactoeTool } from "../tools/tictactoe/tool";

/** Complete tool inventory in stable (alphabetical) order. */
export const allTools = [...workerTools, pickCard, playTttTool].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** Server-composition-owned ordinary interactive tools. */
export const mcpPluginTools = [askQuestion, bookFlightTool, tictactoeTool] as const;

type NamedTool = { name: string };

function createToolRegistry(mcpTools: readonly NamedTool[]): McpToolRegistry {
  const map = new Map<string, unknown>();
  for (const tool of mcpTools) {
    map.set(tool.name, tool);
  }

  return {
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    names: () => Array.from(map.keys()),
  };
}

/** Complete AgentCore inventory; pick_card appears only after exact program readiness. */
export function activeAgentCoreToolNames(pickCardProgramReady = false): string[] {
  return [
    ...workerTools.map((tool) => tool.name),
    ...(pickCardProgramReady ? [pickCard.name] : []),
  ];
}

export const mcpToolRegistry = createToolRegistry(mcpPluginTools);

console.info("[yo-chat] active server tools", {
  availableToolNames: mcpPluginTools.map((tool) => tool.name),
});

export function* setupYoChatBaseContexts(): Operation<void> {
  yield* PersonaResolverContext.set(resolvePersona);
  yield* MaxIterationsContext.set(10);
  yield* McpToolRegistryContext.set(mcpToolRegistry);
}
