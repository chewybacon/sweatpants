import type {
  StandaloneClientOptions,
  StandaloneSnapshot,
  StandaloneInteraction,
} from "./contracts.ts";
import { createChatClient, type ToolPresentationQuestion } from "@sweatpan.ts/chat-client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ToolContract } from "@sweatpan.ts/tools";
import { parseStandaloneAnswer, parseStandaloneView } from "./protocol.ts";
import type { StandaloneAnswer, StandaloneView } from "./contracts.ts";

type Retained = {
  version: "tool-client/1";
  program: string;
  execution: string;
  input: unknown;
  pending?: StandaloneAnswer;
  pendingSequence?: number;
};
/** Application-owned retained command policy composed with the shared observation client.
 * This standalone example has no polling or automatic mutation on reconnect. */
export function createStandaloneClient<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
>(contract: ToolContract<S, D, L, R> & { readonly elicits: L }, options: StandaloneClientOptions) {
  const send = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const key = options.storageKey ?? `tool-client/1:${options.endpoint}:${contract.id}`;
  let saved: Retained | undefined;
  let storage: ReturnType<NonNullable<StandaloneClientOptions["storage"]>> | undefined;
  let connected = false;
  let active: AbortController | undefined;
  let sendingAnswer: AbortSignal | undefined;
  let snapshot: StandaloneSnapshot<R> = Object.freeze({
    loaded: false,
    busy: false,
    pending: false,
  });
  let context: unknown;
  let contexts = new Map<number, unknown>();
  let presentation: readonly ToolPresentationQuestion[] = Object.freeze([]);
  const listeners = new Set<() => void>();
  function createObservation() {
    const source = createChatClient<
      StandaloneView<R> | undefined,
      "POST" | "PUT",
      StandaloneView<R> | undefined
    >({
      transport: {
        observe: () => request("GET", active!.signal),
        answer: (method) => request(method, active!.signal),
      },
    });
    source.subscribe(() => {
      const observed = source.getSnapshot();
      if (connected && observed.status === "ready") {
        publish({ view: observed.view });
      }
    });
    return source;
  }
  let observation = createObservation();
  async function advance(method: "POST" | "PUT") {
    const source = observation;
    await source.answer(method);
    // Reading after a command is this example's policy, not implicit client advancement.
    // Capture the receiver so an old request cannot refresh a reconnected owner.
    await source.refresh();
  }
  function publish(next: Partial<StandaloneSnapshot<R>>) {
    snapshot = Object.freeze({ ...snapshot, ...next });
    updatePresentation();
    for (const listener of listeners) {
      listener();
    }
  }
  function remember(next: Retained) {
    const serialized = JSON.stringify(next);
    storage?.setItem(key, serialized);
    saved = JSON.parse(serialized) as Retained;
    publish({ execution: saved.execution, pending: !!saved.pending });
  }
  async function request(method: "GET" | "POST" | "PUT", signal: AbortSignal) {
    if (method !== "PUT") {
      return exchangeRequest(method, signal);
    }
    sendingAnswer = signal;
    publish({});
    try {
      return await exchangeRequest(method, signal);
    } finally {
      if (sendingAnswer === signal) {
        sendingAnswer = undefined;
        publish({});
      }
    }
  }
  async function exchangeRequest(method: "GET" | "POST" | "PUT", signal: AbortSignal) {
    const current = saved!;
    const response = await send(
      `${options.endpoint.replace(/\/$/, "")}/${encodeURIComponent(current.execution)}`,
      {
        method,
        signal,
        headers: { "Content-Type": "application/json" },
        body:
          method === "GET"
            ? undefined
            : JSON.stringify(method === "POST" ? { input: current.input } : current.pending),
      },
    );
    if (method === "GET" && response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Tool request failed (${response.status})`);
    }
    let data: unknown = await response.json();
    if (method === "PUT") {
      if (
        !data ||
        typeof data !== "object" ||
        !("receipt" in data) ||
        typeof data.receipt !== "string" ||
        !data.receipt ||
        !("duplicate" in data) ||
        typeof data.duplicate !== "boolean" ||
        !("view" in data)
      ) {
        throw new Error("Invalid answer receipt");
      }
      data = data.view;
    }
    const view = parseStandaloneView(data);
    if (view.execution !== current.execution || view.program !== contract.id) {
      throw new Error("Tool response belongs to another interaction");
    }
    const decodedQuestions = new Map<number, unknown>();
    for (const question of view.questions) {
      const effect = Object.values(contract.elicits).find(
        (effect) => effect.id === question.effect,
      );
      if (!effect) {
        throw new Error("Undeclared tool interaction");
      }
      const result = await effect.context["~standard"].validate(question.input);
      if (result.issues) {
        throw new Error("Invalid interaction input");
      }
      decodedQuestions.set(question.sequence, result.value);
    }
    const waiting = view.questions.filter((question) => question.state === "waiting");
    if (
      view.status === "waiting" &&
      (waiting.length !== 1 || waiting[0]!.effect !== view.question.effect)
    ) {
      throw new Error("Invalid waiting question history");
    }
    if (signal.aborted) {
      return;
    }
    contexts = decodedQuestions;
    context = waiting.length ? contexts.get(waiting[0]!.sequence) : undefined;
    if (method === "PUT" || view.status === "completed" || view.status === "cancelled") {
      remember({ ...current, pending: undefined, pendingSequence: undefined });
    }
    // Inferred tool results are not a runtime output schema.
    return view as StandaloneView<R>;
  }
  async function perform(work: (signal: AbortSignal) => Promise<void>) {
    if (!connected || active) {
      return;
    }
    const controller = new AbortController();
    active = controller;
    publish({ busy: true, error: undefined });
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        publish({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (active === controller) {
        active = undefined;
        publish({ busy: false });
      }
    }
  }
  function answer(view: StandaloneView<R>, outcome: StandaloneAnswer["outcome"]) {
    if (view.status !== "waiting" || snapshot.view !== view || !saved || saved.pending) {
      return Promise.resolve();
    }
    const retained = saved;
    return perform(async (signal) => {
      const effect = Object.values(contract.elicits).find(
        (effect) => effect.id === view.question.effect,
      )!;
      if (outcome.ok && effect.response) {
        const result = await effect.response["~standard"].validate(outcome.value);
        if (signal.aborted) {
          return;
        }
        if (result.issues) {
          throw new Error("Invalid interaction response");
        }
      }
      remember({
        ...retained,
        pending: { grant: view.question.grant, outcome },
        pendingSequence: view.questions.find((question) => question.state === "waiting")!.sequence,
      });
      await advance("PUT");
    });
  }
  function updatePresentation() {
    const view = snapshot.view;
    presentation = Object.freeze(
      (view?.questions ?? []).map((question): ToolPresentationQuestion => {
        const current = question.state === "waiting" && view?.status === "waiting";
        const pending =
          saved?.pending &&
          (saved.pendingSequence === question.sequence ||
            (saved.pendingSequence === undefined &&
              current &&
              view.status === "waiting" &&
              saved.pending.grant.requestId === view.question.grant.requestId &&
              saved.pending.grant.resolutionId === view.question.grant.resolutionId))
            ? saved.pending
            : undefined;
        const canRespond = connected && current && !saved?.pending && !snapshot.busy;
        return Object.freeze({
          id: JSON.stringify([view!.execution, question.sequence]),
          execution: view!.execution,
          program: view!.program,
          effect: question.effect,
          input: contexts.get(question.sequence),
          state:
            question.state === "waiting" || question.state === "blocked"
              ? "pending"
              : question.state,
          delivery: pending
            ? sendingAnswer && !sendingAnswer.aborted
              ? "sending"
              : "unconfirmed"
            : "idle",
          canRespond,
          submitted: pending?.outcome,
          outcome: question.state === "answered" ? question.outcome : undefined,
          error: question.state === "failed" ? question.error : undefined,
          respond: (value: unknown) =>
            canRespond ? answer(view!, { ok: true, value }) : Promise.resolve(),
          async decline(failure: unknown) {
            if (canRespond) {
              await answer(view!, { ok: false, error: failure });
            }
          },
        });
      }),
    );
  }
  const client = {
    presentation: {
      getSnapshot: () => presentation,
      subscribe(notify: () => void) {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      if (connected) {
        return Promise.resolve();
      }
      connected = true;
      observation = createObservation();
      return perform(async () => {
        publish({ loaded: true });
        storage = options.storage?.();
        const raw = storage?.getItem(key);
        if (raw) {
          const value = JSON.parse(raw) as Retained;
          if (
            value.version !== "tool-client/1" ||
            value.program !== contract.id ||
            typeof value.execution !== "string" ||
            !/^[a-zA-Z0-9_-]{1,200}$/.test(value.execution) ||
            !Object.hasOwn(value, "input")
          ) {
            throw new Error("Invalid saved tool interaction");
          }
          saved = {
            ...value,
            pending: value.pending === undefined ? undefined : parseStandaloneAnswer(value.pending),
          };
        }
        publish({ loaded: true, execution: saved?.execution, pending: !!saved?.pending });
        if (saved) {
          await observation.refresh();
        }
      });
    },
    disconnect() {
      connected = false;
      observation.close();
      active?.abort();
      active = undefined;
      publish({ busy: false });
    },
    start(input: StandardSchemaV1.InferInput<S>) {
      return perform(async () => {
        if (
          saved &&
          snapshot.view?.status !== "completed" &&
          snapshot.view?.status !== "cancelled"
        ) {
          throw new Error("Resolve the current interaction before starting another");
        }
        remember({
          version: "tool-client/1",
          program: contract.id,
          execution: crypto.randomUUID(),
          input,
        });
        publish({ view: undefined });
        await advance("POST");
      });
    },
    refresh() {
      return perform(async () => {
        if (saved) {
          await observation.refresh();
        }
      });
    },
    retry() {
      return perform(async () => {
        if (saved) {
          await advance(saved.pending ? "PUT" : "POST");
        }
      });
    },
    interaction<K extends keyof L>(name: K): StandaloneInteraction<L[K]> | undefined {
      const view = snapshot.view;
      if (
        view?.status !== "waiting" ||
        saved?.pending ||
        contract.elicits[name].id !== view.question.effect
      ) {
        return undefined;
      }
      return {
        input: context,
        respond: (value: unknown) => answer(view, { ok: true, value }),
      } as StandaloneInteraction<L[K]>;
    },
  };
  return client;
}
