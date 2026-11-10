import type { ToolPresentationQuestion } from "@sweatpan.ts/chat-client";
import {
  chatView,
  chatCommand,
  type ChatView,
  type ChatCommand,
  type ChatQuestion,
} from "./contract.ts";

export function createDemoClient(
  options: {
    endpoint: string;
    storageKey: string;
    viewEvent: string;
    decodeInput(effect: string, input: unknown): unknown;
  },
  send: typeof fetch = fetch,
) {
  type Retained = {
    thread: string;
    title: string;
    pending?: ChatCommand;
    pendingQuestion?: string;
  };
  type State = {
    loaded: boolean;
    busy: boolean;
    view?: ChatView;
    error?: string;
    text: string;
    pending?: ChatCommand;
    threads: { thread: string; title: string }[];
    current?: string;
  };
  let snapshot: State = { loaded: false, busy: false, text: "", threads: [] };
  let presentation: readonly ToolPresentationQuestion[] = [];
  let saved: Retained | undefined;
  let active: AbortController | undefined;
  let sendingAnswer = false;
  let connected = false;
  const listeners = new Set<() => void>();
  const storageKey = options.storageKey;
  let threads: Retained[] = [];
  function persist() {
    if (saved) {
      threads = [...threads.filter((entry) => entry.thread !== saved!.thread), saved];
    }
    sessionStorage.setItem(storageKey, JSON.stringify({ current: saved?.thread, threads }));
  }
  function publish(next: Partial<State>) {
    snapshot = Object.freeze({
      ...snapshot,
      ...next,
      current: saved?.thread,
      pending: saved?.pending,
      threads: threads.map(({ thread, title }) => ({ thread, title })),
    });
    presentation = Object.freeze(
      (snapshot.view?.turns ?? [])
        .flatMap((turn) =>
          turn.parts.flatMap((part) => (part.type === "tool" ? part.questions : [])),
        )
        .map((question): ToolPresentationQuestion => {
          const pending = saved?.pending;
          const selected =
            pending?.type === "answer" &&
            pending.execution === question.execution &&
            (saved?.pendingQuestion === question.id ||
              (saved?.pendingQuestion === undefined &&
                pending.grant.requestId === question.grant?.requestId))
              ? pending
              : undefined;
          return Object.freeze({
            id: question.id,
            execution: question.execution,
            program: question.program,
            effect: question.effect,
            input: options.decodeInput(question.effect, question.input),
            state:
              question.state === "open" || question.state === "blocked"
                ? "pending"
                : question.state,
            delivery: selected ? (sendingAnswer ? "sending" : "unconfirmed") : "idle",
            canRespond: connected && question.state === "open" && !snapshot.busy && !pending,
            submitted: selected ? { ok: true, value: selected.value } : undefined,
            outcome:
              question.state === "answered" ? { ok: true, value: question.value } : undefined,
            respond: (value) => answer(question, value),
          });
        }),
    );
    for (const listener of listeners) {
      listener();
    }
  }
  async function exchange(command?: ChatCommand) {
    if (!connected || active || !saved) {
      return;
    }
    const controller = new AbortController();
    active = controller;
    sendingAnswer = command?.type === "answer";
    publish({ busy: true, error: undefined, text: "" });
    try {
      const response = await send(`${options.endpoint}/${encodeURIComponent(saved.thread)}`, {
        method: command ? "POST" : "GET",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: command ? JSON.stringify(command) : undefined,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Chat request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let observed: ChatView | undefined;
      let finished = false;
      try {
        while (true) {
          const item = await reader.read();
          if (controller.signal.aborted) {
            return;
          }
          if (item.done) {
            break;
          }
          buffer += decoder.decode(item.value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (!line.startsWith("data: ")) {
              continue;
            }
            const event = JSON.parse(line.slice(6));
            if (event.type === "RUN_ERROR") {
              throw new Error(String(event.message));
            }
            if (event.type === "TEXT_MESSAGE_START") {
              publish({ text: "" });
            }
            if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") {
              publish({ text: snapshot.text + event.delta });
            }
            if (event.type === "CUSTOM" && event.name === options.viewEvent) {
              observed = chatView.parse(event.value);
              if (observed.thread !== saved.thread) {
                throw new Error("Wrong conversation response");
              }
            }
            if (event.type === "RUN_FINISHED") {
              finished = true;
            }
          }
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (!finished || !observed) {
        throw new Error("Confirmation was lost. Retry the same command.");
      }
      if (command) {
        saved = { ...saved, pending: undefined, pendingQuestion: undefined };
        persist();
      }
      publish({ view: observed, text: "" });
    } catch (error) {
      if (!controller.signal.aborted) {
        publish({ error: error instanceof Error ? error.message : "Chat request failed" });
      }
    } finally {
      if (active === controller) {
        active = undefined;
        sendingAnswer = false;
        publish({ busy: false });
      }
    }
  }
  function issue(command: ChatCommand, pendingQuestion?: string) {
    if (!connected || !saved || active || saved.pending) {
      return Promise.resolve();
    }
    saved = { ...saved, pending: command, pendingQuestion };
    persist();
    return exchange(command);
  }
  async function answer(question: ChatQuestion, value: unknown) {
    if (
      !connected ||
      !presentation.some((entry) => entry.id === question.id && entry.canRespond) ||
      !question.grant
    ) {
      return;
    }
    const command = chatCommand.parse({
      type: "answer",
      root: question.root,
      execution: question.execution,
      grant: question.grant,
      value,
    });
    await issue(command, question.id);
  }
  const subscribe = (notify: () => void) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  };
  return {
    getSnapshot: () => snapshot,
    subscribe,
    presentation: { getSnapshot: () => presentation, subscribe },
    async connect() {
      connected = true;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const decoded = JSON.parse(raw) as { current?: string; threads: Retained[] };
          if (!Array.isArray(decoded.threads)) {
            throw new Error("Invalid saved conversations");
          }
          threads = decoded.threads.map((entry) => {
            if (!/^[a-zA-Z0-9_-]{1,200}$/.test(entry.thread) || typeof entry.title !== "string") {
              throw new Error("Invalid saved conversation");
            }
            return {
              ...entry,
              pending: entry.pending ? chatCommand.parse(entry.pending) : undefined,
              pendingQuestion:
                typeof entry.pendingQuestion === "string" ? entry.pendingQuestion : undefined,
            };
          });
          saved = threads.find((entry) => entry.thread === decoded.current);
        }
        if (!saved) {
          saved = { thread: crypto.randomUUID(), title: "New conversation" };
          persist();
        }
        publish({ loaded: true });
        await exchange();
      } catch (error) {
        publish({ loaded: true, error: String(error) });
      }
    },
    disconnect() {
      connected = false;
      active?.abort();
      active = undefined;
      sendingAnswer = false;
      publish({ busy: false });
    },
    async select(thread?: string) {
      if (active) {
        return;
      }
      saved = thread
        ? threads.find((entry) => entry.thread === thread)
        : { thread: crypto.randomUUID(), title: "New conversation" };
      persist();
      publish({ view: undefined, error: undefined, text: "" });
      await exchange();
    },
    async submit(prompt: string) {
      if (!saved || snapshot.busy || saved.pending || !prompt.trim()) {
        return;
      }
      if (snapshot.view?.turns.at(-1)?.status === "running") {
        return;
      }
      if (saved.title === "New conversation") {
        saved = { ...saved, title: prompt.trim().slice(0, 45) };
      }
      await issue({
        type: "message",
        command: crypto.randomUUID(),
        prompt: prompt.trim(),
        after: snapshot.view?.latest ?? null,
      });
    },
    retry: () => exchange(saved?.pending),
    refresh: () => exchange(),
    resume: () =>
      snapshot.view?.latest
        ? issue({ type: "continue", root: snapshot.view.latest })
        : Promise.resolve(),
  };
}
