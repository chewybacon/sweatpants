import { createElement, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { Operation } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  defineElicitPlugins,
  createElicitResponder,
  type ElicitMetadata,
  type ElicitPlugin,
} from "@sweatpan.ts/tools";
import type { EffectDefinition } from "@sweatpan.ts/core";

// The component owns its concrete reply type; never permits every response callback
// here without widening the inferred result to unknown or any.
type RespondingProps = { readonly onRespond: (value: never) => void };
export interface ReactElicitCapabilities<Y> {
  render<Props extends RespondingProps>(
    component: ComponentType<Props>,
    props: Omit<Props, "onRespond">,
  ): Operation<Parameters<Props["onRespond"]>[0], Y>;
}
export interface ElicitRender {
  readonly id: string;
  readonly interaction: ElicitMetadata;
  readonly node: ReactNode;
}

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

/** Subscription only: unmounting a view does not cancel a shared session's handler. */
export function ElicitViews({
  host,
  execution,
}: {
  readonly execution?: string;
  readonly host: Pick<ReturnType<typeof createReactElicitHost>, "getSnapshot" | "subscribe">;
}) {
  const slots = useSyncExternalStore(host.subscribe, host.getSnapshot);
  return (
    <>
      {slots
        .filter((slot) => !execution || slot.interaction.execution === execution)
        .map((slot) => (
          <section
            key={slot.id}
            data-execution={slot.interaction.execution}
            data-question={slot.interaction.requestId}
          >
            {slot.node}
          </section>
        ))}
    </>
  );
}

export function SeatPicker({
  flight,
  seats,
  onRespond,
}: {
  readonly flight: string;
  readonly seats: readonly string[];
  readonly onRespond: (seat: "2A" | "2B") => void;
}) {
  return (
    <fieldset>
      <legend>Choose a seat for {flight}</legend>
      {(["2A", "2B"] as const)
        .filter((seat) => seats.includes(seat))
        .map((seat) => (
          <button key={seat} onClick={() => onRespond(seat)}>
            Seat {seat}
          </button>
        ))}
    </fieldset>
  );
}
