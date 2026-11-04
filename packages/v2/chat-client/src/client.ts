import type { ChatClient, ChatClientOptions, ChatViewSnapshot } from "./contracts.ts";

/** Create an idle shared client over an application transport. Call refresh explicitly;
 * subscriptions observe state and never take ownership of execution or transport. */
export function createChatClient<V, Command, Receipt>({
  transport,
}: ChatClientOptions<V, Command, Receipt>): ChatClient<V, Command, Receipt> {
  let snapshot: ChatViewSnapshot<V> = Object.freeze({
    view: undefined,
    status: "idle",
    error: undefined,
  });
  const listeners = new Set<() => void>();
  let generation = 0;
  let closed = false;
  function publish(next: ChatViewSnapshot<V>) {
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      listener();
    }
  }
  function check() {
    if (closed) {
      throw new Error("Conversation viewer is closed");
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      check();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      check();
      const request = ++generation;
      publish({ view: snapshot.view, status: "loading", error: undefined });
      try {
        const view = await transport.observe();
        if (!closed && request === generation) {
          publish({ view, status: "ready", error: undefined });
        }
      } catch (error) {
        if (!closed && request === generation) {
          publish({ view: snapshot.view, status: "error", error });
          throw error;
        }
      }
      return snapshot.view;
    },
    answer(command: Command) {
      check();
      return transport.answer(command);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      generation++;
      publish({ view: undefined, status: "closed", error: undefined });
      listeners.clear();
    },
  };
}
