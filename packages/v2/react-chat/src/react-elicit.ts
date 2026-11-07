import { createElement } from "react";
import type { ComponentType } from "react";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  defineElicitPlugins,
  createElicitResponder,
  type ElicitMetadata,
  type ElicitPlugin,
} from "@sweatpan.ts/tools";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ElicitRender, ReactElicitCapabilities } from "./contracts.ts";
import type { RespondingProps } from "./types.ts";
/** One frontend session's local presentation store. It does not own handler tasks. */
export function createReactElicitHost<Y>(runtime: Runtime<Y>) {
  let snapshot: readonly ElicitRender[] = [];
  const listeners = new Set<() => void>();
  function publish(next: readonly ElicitRender[]) {
    snapshot = next;
    for (const notify of [...listeners]) {
      notify();
    }
  }
  const capabilities = (interaction: ElicitMetadata): ReactElicitCapabilities<Y> => ({
    *render<Props extends RespondingProps>(
      component: ComponentType<Props>,
      props: Omit<Props, "onRespond">,
    ) {
      type Reply = Parameters<Props["onRespond"]>[0];
      return yield* runtime.composition.scoped(function* () {
        const id = JSON.stringify([
          interaction.execution,
          interaction.requestId,
          interaction.resolutionId,
        ]);
        if (snapshot.some((slot) => slot.id === id)) {
          throw new Error("Interaction already has an active local render");
        }
        const responses = runtime.createSignal<Reply>();
        // Subscribe before publishing UI: even an immediate response must be retained.
        const reader = yield* responses;
        let active = true;
        yield* runtime.composition.ensure(function* () {
          active = false;
          publish(snapshot.filter((slot) => slot.id !== id));
        });
        function onRespond(value: Reply) {
          if (active) {
            active = false;
            responses.send(value);
          }
        }
        // Props/result correlation is retained by the public render signature.
        const rendered = { ...props, onRespond } as Props;
        publish([
          ...snapshot,
          Object.freeze({ id, interaction, node: createElement(component, rendered) }),
        ]);
        const next = yield* reader.next();
        if (next.done) {
          throw new Error("Presentation ended without an answer");
        }
        return next.value;
      });
    },
  });
  return {
    definePlugin: defineElicitPlugins<ReactElicitCapabilities<Y>>(),
    bindPlugin<L extends Record<string, EffectDefinition>>(
      plugin: ElicitPlugin<L, ReactElicitCapabilities<Y>, NoInfer<Y>>,
    ) {
      return createElicitResponder(
        runtime,
        `react-elicit:${plugin.support.tool}`,
        plugin,
        capabilities,
      );
    },
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}
