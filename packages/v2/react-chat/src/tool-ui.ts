import {
  createContext,
  createElement,
  Fragment,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactNode } from "react";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ToolPresentationQuestion } from "@sweatpan.ts/chat-client";
import type {
  ToolUIProps,
  ToolUIPlugin,
  ToolUIProviderProps,
  ToolOutletProps,
} from "./contracts.ts";

/** Pure declaration shared by standalone and conversation presentation sources.
 * Sources supply schema-decoded input and accepted outcomes; no schema transform
 * or delivery is performed while rendering. */
export function defineToolUI<L extends Record<string, EffectDefinition>>(
  tool: { readonly id: string; readonly elicits: L },
  components: { readonly [K in keyof L]: ComponentType<ToolUIProps<L[K]>> },
): ToolUIPlugin {
  const renderers = new Map<string, (question: ToolPresentationQuestion) => ReactNode>();
  for (const name of Object.keys(tool.elicits)) {
    const definition = tool.elicits[name]!;
    if (renderers.has(definition.id)) {
      throw new Error("Duplicate tool UI effect identity");
    }
    const component = components[name];
    if (!component) {
      throw new Error(`Missing tool UI component: ${name}`);
    }
    renderers.set(definition.id, (question) => {
      // The registry erases aliases only here; the public mapping retains each
      // declaration's context, raw response and accepted Outcome correlation.
      const props = {
        input: question.input,
        state: question.state,
        delivery: question.delivery,
        disabled: !question.canRespond,
        submitted: question.submitted,
        outcome: question.outcome,
        error: question.error,
        respond: question.respond,
        decline: question.decline,
      } as ToolUIProps<L[string]>;
      return createElement(component, { ...props, key: question.id });
    });
  }
  return Object.freeze({
    program: tool.id,
    render(question: ToolPresentationQuestion) {
      if (question.program !== tool.id) {
        throw new Error("Tool UI program mismatch");
      }
      const render = renderers.get(question.effect);
      if (!render) {
        return createElement(
          "p",
          { role: "status" },
          `No UI registered for ${question.program}/${question.effect}`,
        );
      }
      return render(question);
    },
  });
}
const UI = createContext<
  (ToolUIProviderProps & { readonly registry: ReadonlyMap<string, ToolUIPlugin> }) | undefined
>(undefined);

/** Registration and placement only. Mounting/unmounting never starts, answers or
 * cancels a tool. The source's owner controls connection and execution lifetime. */
export function ToolUIProvider(props: ToolUIProviderProps) {
  const registry = useMemo(() => {
    const map = new Map<string, ToolUIPlugin>();
    for (const plugin of props.plugins) {
      if (map.has(plugin.program)) {
        throw new Error("Duplicate tool UI registration");
      }
      map.set(plugin.program, plugin);
    }
    return map;
  }, [props.plugins]);
  return createElement(UI.Provider, { value: { ...props, registry } }, props.children);
}

/** Render questions at their selected location. The message tree owns surrounding
 * text, nested activity and results; this outlet never flattens or owns that tree. */
export function ToolOutlet({ placement = "inline", execution, question }: ToolOutletProps) {
  const ui = useContext(UI);
  if (!ui) {
    throw new Error("Missing ToolUIProvider");
  }
  const entries = useSyncExternalStore(
    ui.source.subscribe,
    ui.source.getSnapshot,
    ui.source.getSnapshot,
  );
  return createElement(
    Fragment,
    null,
    ...entries
      .filter(
        (entry) =>
          (ui.placement?.(entry) ?? "inline") === placement &&
          (execution === undefined || entry.execution === execution) &&
          (question === undefined || entry.id === question),
      )
      .map((entry) => {
        const plugin = ui.registry.get(entry.program);
        if (!plugin) {
          return createElement(
            "p",
            { key: entry.id, role: "status" },
            `No UI registered for ${entry.program}`,
          );
        }
        return createElement(Fragment, { key: entry.id }, plugin.render(entry));
      }),
  );
}
