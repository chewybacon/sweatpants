import { useMemo, useSyncExternalStore } from "react";
import type { ChatViewSnapshot } from "@sweatpan.ts/chat-client";
import type { ChatViewSource } from "@sweatpan.ts/chat-client";

/** Subscribe to an externally owned client. Unmount only unsubscribes. Commands
 * remain on the supplied client; no initialization, retry or advancement is hidden
 * in React lifecycle. Server rendering requires a suitably initialized client. */
export function useChat<V>(client: ChatViewSource<V>): ChatViewSnapshot<V> {
  const store = useMemo(
    () => ({
      subscribe: client.subscribe.bind(client),
      snapshot: client.getSnapshot.bind(client),
    }),
    [client],
  );
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
