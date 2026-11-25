import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createChatToolBinding,
  type ChatProgram,
  type ChatRecoveryFactory,
} from "@sweatpan.ts/chat-host";
import { createRecovery } from "@sweatpan.ts/durable";
import { childHostingResult } from "@sweatpan.ts/hosting";
import { createToolSession, installToolRouting, isAuthoredTool } from "@sweatpan.ts/tools";
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
      children: [...new Set(Object.values(tool.capabilities).filter(isAuthoredTool))],
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
      const identities = new Map<string, object>(catalog.map(({ tool }) => [tool.id, tool]));
      const descendantInteractionContracts = new Map<
        string,
        (typeof catalog)[number]["children"][number]
      >();
      for (const { children } of catalog) {
        for (const child of children) {
          const existing = identities.get(child.id);
          if (existing && existing !== child) {
            throw new Error(`Conflicting authored tool: ${child.id}`);
          }
          identities.set(child.id, child);
          if (!names.has(child.id)) {
            descendantInteractionContracts.set(child.id, child);
          }
        }
      }
      return program.bind(runtime, {
        ...run,
        ...defaults,
        descendantInteractionContracts: [...descendantInteractionContracts.values()],
        tools: catalog.map(({ tool, children, definition }) =>
          // Keep the schema, body and grant declarations together across catalog
          // erasure. The existing binding owns admission before body acquisition.
          createChatToolBinding(runtime, tool as BoundTool, {
            definition,
            ...defaults,
            *configure({ effects, host, journal }) {
              for (const child of children) {
                yield* installToolRouting(runtime, host, journal, {
                  tool: child,
                  *run(owned) {
                    const session = createToolSession(runtime, child, {
                      journal: owned.journal,
                      child: owned.link,
                      ...defaults,
                      *configure(context) {
                        if (installEffects) {
                          yield* installEffects(context.effects);
                        }
                      },
                    });
                    return childHostingResult(yield* session.run());
                  },
                });
              }
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
