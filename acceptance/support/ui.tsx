import { call, resource, type Operation } from "effection";
import {
  createChatClient,
  type ReactChatClient,
  type ReactClientPlugin,
  type ChatQueueOption,
} from "@sweatpants/react-chat";
import type { ScenarioContext } from "@sweatpants/test-rig";
import { TripChat } from "../fixtures/trip-chat.tsx";
import { renderUI } from "./dom.tsx";

interface TestUIOptions {
  plugins: readonly ReactClientPlugin[];
  threadId?: string;
  api?: string;
  queue?: ChatQueueOption;
}

type TestUI = ReturnType<typeof renderUI> & { readonly client: ReactChatClient };

/** Compose the example UI with a real public client and scope-owned cleanup. */
export function useUI(
  rig: Pick<ScenarioContext, "transport">,
  options: TestUIOptions,
): Operation<TestUI> {
  return resource(function* (provide) {
    const client = createChatClient({
      threadId: options.threadId ?? "trip",
      plugins: options.plugins,
      queue: options.queue,
      transport: { http: { api: options.api ?? "/assistant/chat", fetch: rig.transport.fetch } },
    });
    try {
      using view = renderUI(<TripChat client={client} />);
      yield* provide({ ...view, client });
    } finally {
      yield* call(() => client.close());
    }
  });
}
