import { action, call, resource, type Operation } from "effection";
import {
  createChatClient,
  type CreateReactChatClientOptions,
  type ReactChatClient,
} from "@sweatpants/react-chat";
import type { ScenarioContext } from "@sweatpants/test-rig";

/** Own a public client; actions and assertions stay in the scenario. */
export function useClient(
  rig: Pick<ScenarioContext, "transport">,
  options: Omit<CreateReactChatClientOptions, "transport">,
): Operation<ReactChatClient> {
  return resource(function* (provide) {
    const client = createChatClient({
      ...options,
      transport: { http: { api: "/assistant/chat", fetch: rig.transport.fetch } },
    });
    try {
      yield* call(() => client.initialized);
      yield* provide(client);
    } finally {
      yield* call(() => client.close());
    }
  });
}

/** Subscribe to public snapshots without polling or rewriting history. */
export function waitForSnapshot(
  client: ReactChatClient,
  predicate: (snapshot: ReturnType<ReactChatClient["getSnapshot"]>) => boolean,
): Operation<ReturnType<ReactChatClient["getSnapshot"]>> {
  return action((resolve, reject) => {
    const check = () => {
      try {
        const next = client.getSnapshot();
        if (predicate(next)) {
          resolve(next);
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const unsubscribe = client.subscribe(check);
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Snapshot condition not reached: ${JSON.stringify(client.getSnapshot()).slice(-2500)}`,
          ),
        ),
      10_000,
    );
    check();
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  });
}
