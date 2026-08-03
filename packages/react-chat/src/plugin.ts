import type { Operation } from "effection";
import type { ComponentProps, ComponentType } from "react";
import {
  createPluginBuilder,
  type ClientPlugin,
  type PluginBuilder,
  type PluginToolContract,
} from "@sweatpants/tool-session/mcp";
import type { ExtractElicitResponseInput } from "@sweatpants/agent-sdk";

/** The package-local completed-interaction convention. */
export interface ReactRenderableProps<TResponse = unknown> {
  readonly onRespond: (value: TResponse) => void;
  readonly disabled?: boolean;
  readonly response?: TResponse;
}

export type ReactUserProps<TProps> = Omit<TProps, keyof ReactRenderableProps>;

// eslint-disable-next-line typescript-eslint/no-explicit-any -- React component props are intentionally inferred at each binding.
export type ReactResponseFor<TComponent extends ComponentType<any>> =
  ComponentProps<TComponent> extends {
    readonly onRespond: (value: infer TResponse) => void;
  }
    ? TResponse
    : never;

/** Native React capability context supplied to an authored handler. */
export interface ReactElicitCapabilities {
  readonly signal: AbortSignal;
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- The concrete component supplies the prop type.
  render<TComponent extends ComponentType<any>>(
    component: TComponent,
    props: ReactUserProps<ComponentProps<TComponent>>,
  ): Operation<ReactResponseFor<TComponent>>;
  reportProgress?(message: string): Operation<void>;
}

/** React-local plugin facade; no server registration is included. */
export function makePlugin<TContract extends PluginToolContract>(
  tool: TContract,
): PluginBuilder<TContract, ReactElicitCapabilities> {
  return createPluginBuilder<ReactElicitCapabilities, TContract>(tool);
}

export type ReactClientPlugin = ClientPlugin<ReactElicitCapabilities>;

/** Compile-time helper for response inference in framework tests. */
export type ReactAcceptedContent<TDefinition> = ExtractElicitResponseInput<TDefinition>;
