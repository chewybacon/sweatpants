import { setupDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { responseStores } from "./local-d1-storage-config";

export function* setupYoChatDurableStreams() {
  yield* setupDurableStreams({ ...responseStores, retentionPolicy: { mode: "retain_forever" } });
}
