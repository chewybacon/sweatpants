import React, { type ComponentType } from "react";
import { createSignal, type Operation } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  createClientElicitDispatcher,
  createPluginRegistryFrom,
  type ClientElicitDispatcher,
  type ClientPlugin,
  type RawClientElicit,
} from "@sweatpants/tool-session/mcp";
import type {
  ChatInteractionCompletion,
  ChatInteractionRuntime,
  ChatInteractionRequest,
} from "@sweatpants/chat-client";
import type { ReactElicitCapabilities } from "./plugin.ts";
import type { ReactRenderPart } from "./react-types.ts";

export interface ReactInteractionOptions {
  readonly plugins?: readonly ClientPlugin<ReactElicitCapabilities>[];
}

function asJson(value: unknown): Json {
  return assertJson(value);
}

/** Client-local native interaction driver used by the React facade. */
export class ReactInteractionRuntime implements ChatInteractionRuntime<ReactRenderPart> {
  private readonly registry;
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, ReactRenderPart[]>();
  private readonly hostSettled = new Set<string>();
  private readonly sequence = new Map<string, number>();
  private readonly dispatcher: ClientElicitDispatcher;
  private completionHandler:
    | ((request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void)
    | null = null;
  private disposed = false;

  constructor(options: ReactInteractionOptions = {}) {
    this.registry = createPluginRegistryFrom(
      (options.plugins ?? []).map((plugin) => plugin.client),
    );
    this.dispatcher = createClientElicitDispatcher<ReactElicitCapabilities>({
      registry: this.registry,
      createCapabilities: (request, _binding, signal) => this.capabilities(request, signal),
      onCompletion: (request, completion) => {
        if (!this.completionHandler) {
          return;
        }
        const normalized: ChatInteractionCompletion =
          completion.action === "accept"
            ? { action: "accept", content: asJson(completion.content) }
            : completion.action === "decline"
              ? { action: "decline" }
              : { action: "cancel" };
        this.completionHandler(request, normalized);
      },
      onDiagnostic: () => this.notify(),
    });
  }

  observe(request: ChatInteractionRequest): void {
    if (this.disposed || this.hostSettled.has(request.elicitId)) {
      return;
    }
    this.dispatcher.observe(request);
  }

  settled(elicitId: string): void {
    this.hostSettled.add(elicitId);
    this.dispatcher.settled(elicitId);
    const records = this.records.get(elicitId);
    if (records) {
      this.records.set(
        elicitId,
        records.map((record) =>
          Object.freeze({
            ...record,
            state: "completed" as const,
            disabled: true,
            node: React.isValidElement(record.node)
              ? React.cloneElement(
                  record.node as React.ReactElement<{ readonly disabled?: boolean }>,
                  { disabled: true },
                )
              : record.node,
          }),
        ),
      );
    }
    this.notify();
  }

  cancel(elicitId: string): void {
    this.hostSettled.add(elicitId);
    this.dispatcher.cancel(elicitId);
    this.records.delete(elicitId);
    this.notify();
  }

  localParts(): ReadonlyMap<string, readonly ReactRenderPart[]> {
    return this.records;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setOnCompletion(
    handler: (request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void,
  ): void {
    this.completionHandler = handler;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dispatcher.dispose();
    this.records.clear();
    this.hostSettled.clear();
    this.listeners.clear();
  }

  private capabilities(request: RawClientElicit, signal: AbortSignal): ReactElicitCapabilities {
    return {
      signal,
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- Runtime preserves the concrete component's inferred props.
      render: <TComponent extends ComponentType<any>>(
        component: TComponent,
        props: Omit<React.ComponentProps<TComponent>, "onRespond" | "disabled" | "response">,
      ): Operation<
        React.ComponentProps<TComponent> extends {
          readonly onRespond: (value: infer TResponse) => void;
        }
          ? TResponse
          : never
      > => {
        return (function* (driver: ReactInteractionRuntime): Operation<
          React.ComponentProps<TComponent> extends {
            readonly onRespond: (value: infer TResponse) => void;
          }
            ? TResponse
            : never
        > {
          const sequence = driver.sequence.get(request.elicitId) ?? 0;
          driver.sequence.set(request.elicitId, sequence + 1);
          const renderId = `${request.elicitId}:render:${sequence}`;
          const response = createSignal<unknown, void>();
          let answered = false;
          const respond = (value: unknown): void => {
            if (
              answered ||
              signal.aborted ||
              driver.disposed ||
              driver.hostSettled.has(request.elicitId)
            ) {
              return;
            }
            answered = true;
            const current = driver.records.get(request.elicitId) ?? [];
            driver.records.set(
              request.elicitId,
              current.map((part) =>
                part.id === renderId
                  ? Object.freeze({
                      ...part,
                      state: "completed" as const,
                      response: asJson(value),
                      node: React.createElement(component, {
                        ...props,
                        disabled: true,
                        response: value,
                      }),
                    })
                  : part,
              ),
            );
            response.send(value);
            driver.notify();
          };
          const record: ReactRenderPart = Object.freeze({
            type: "render",
            id: renderId,
            parentElicitId: request.elicitId,
            sequence,
            state: "pending",
            node: React.createElement(component, { ...props, disabled: false, onRespond: respond }),
          });
          driver.records.set(request.elicitId, [
            ...(driver.records.get(request.elicitId) ?? []),
            record,
          ]);
          driver.notify();
          const subscription = yield* response;
          const next = yield* subscription.next();
          return next.value as React.ComponentProps<TComponent> extends {
            readonly onRespond: (value: infer TResponse) => void;
          }
            ? TResponse
            : never;
        })(this);
      },
      reportProgress: function* (_message: string): Operation<void> {
        return;
      },
    };
  }

  private notify(): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- Subscription mutation must not alter this notification set.
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
