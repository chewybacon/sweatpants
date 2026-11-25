import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createChatToolBinding,
  type ChatProgram,
  type ChatRecoveryFactory,
} from "@sweatpan.ts/chat-host";
import { createRecovery } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { AgentDefinition, AgentRun, AgentTool, BoundTool } from "./contracts.ts";

/** Select authored tools once. Neither selection nor binding starts an execution. */
export function defineAgent({ tools }: { readonly tools: readonly AgentTool[] }): AgentDefinition {
  const names = new Set<string>();
  const catalog = tools.map((tool) => {
    if (names.has(tool.id)) {
      throw new Error(`Duplicate model tool name: ${tool.id}`);
    }
    names.add(tool.id);
    const parameters = z
      .record(z.string(), z.json())
      .parse(z.toJSONSchema(tool.context, { io: "input" }));
    return {
      tool,
      definition: { name: tool.id, description: tool.description ?? null, parameters },
    };
  });

  return Object.freeze({
    bind<R, Y>(
      runtime: Runtime<Y>,
      program: ChatProgram<R>,
      { installEffects, ...run }: AgentRun<R, Y>,
    ) {
      const recovery: ChatRecoveryFactory<Y> = (options) =>
        createRecovery(runtime.composition, options);
      const defaults = { recovery, matches: isDeepStrictEqual };
      return program.bind(runtime, {
        ...run,
        ...defaults,
        tools: catalog.map(({ tool, definition }) =>
          // Keep the schema, body and grant declarations together across catalog
          // erasure. The existing binding owns admission before body acquisition.
          createChatToolBinding(runtime, tool as BoundTool, {
            definition,
            ...defaults,
            *configure({ effects }) {
              if (installEffects) {
                yield* installEffects(effects);
              }
            },
          }),
        ),
      });
    },
  });
}
