import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition, CapabilityRequest } from "@sweatpan.ts/core";
import type { OwnedChild } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
  childHostingResult,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createToolAcquisition,
  installElicitHandlers,
  projectToolContract,
  type ToolDefinition,
} from "@sweatpan.ts/tools";
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
  options: ChatToolBindingOptions<NoInfer<R>, Y>,
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
        const effects = createEffectCapabilities(runtime, `chat-tool:${child.journal.id}`);
        const acquisition = createToolAcquisition(runtime, effects, tool, `acquire:${tool.id}`);
        const recovery = options.recovery<R>({
          name: `recover:${child.journal.id}`,
          program: tool.id,
          matches: options.matches,
          acquire: () =>
            acquisition.operations.acquire(child.link.input as StandardSchemaV1.InferOutput<S>),
        });
        const host = createHosting(runtime.composition, {
          name: `host:${child.journal.id}`,
          journal: bound.journal,
          recovery: recovery.operations,
          attempts: bound.journal.attempts,
          interactions: bound.journal.interactions,
          handle: acquisition.handle,
        });
        yield* installGuestRetention(runtime.composition, host, recovery, bound.journal);
        yield* host.around({
          operations: acquisition.admission,
        });
        yield* installElicitHandlers(host, effects, tool);
        if (options.configure) {
          yield* options.configure({ host, effects });
        }
        return childHostingResult(yield* host.operations.run());
      });
    },
  };
}
