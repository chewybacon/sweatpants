import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition, CapabilityRequest } from "@sweatpan.ts/core";
import type { OwnedChild } from "@sweatpan.ts/durable";
import { childHostingResult } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createToolSession, projectToolContract, type ToolDefinition } from "@sweatpan.ts/tools";
import type { ChatToolBinding, ChatToolBindingOptions } from "./contracts.ts";

/** Capture one original tool's input/result types, hosting recipe and model metadata.
 * Construction performs no work. Each run gets fresh capabilities in its own scope;
 * required retention, admission and participant routing are installed by the binding. */
export function createChatToolBinding<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
  Y,
>(
  runtime: Runtime<Y>,
  tool: ToolDefinition<S, D, L, R>,
  options: ChatToolBindingOptions<NoInfer<R>, Y, StandardSchemaV1.InferOutput<S>>,
): ChatToolBinding<Y> {
  return {
    program: tool.id,
    definition: structuredClone(options.definition),
    context: tool.context,
    contract: projectToolContract(tool),
    elicits: tool.elicits,
    run(child) {
      return runtime.composition.scoped(function* () {
        if (child.link.program !== tool.id || child.link.childId !== child.journal.id) {
          throw new Error("Chat tool child does not match binding");
        }
        // The catalog captures this program's result type before heterogeneous storage
        // erases it. Only a checked program binding restores that trusted protocol.
        const bound = child as OwnedChild<R, CapabilityRequest, unknown, string, unknown, Y>;
        const session = createToolSession(runtime, tool, {
          journal: bound.journal,
          child: child.link,
          recovery: options.recovery,
          matches: options.matches,
          configure: options.configure,
        });
        return childHostingResult(yield* session.run());
      });
    },
  };
}
