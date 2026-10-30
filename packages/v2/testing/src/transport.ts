import { createLocalTransport } from "@sweatpan.ts/connection";
import { MessageChannel } from "node:worker_threads";
import { serialize, deserialize } from "node:v8";
import type { TransportRig } from "./contracts.ts";

/** In-process ordered byte transport; codecs detach values exactly as worker fixtures do. */
export function createTransportRig(kind: "local" | "message-channel" = "local"): TransportRig {
  const [port1, port2] =
    kind === "local"
      ? createLocalTransport()
      : (() => {
          const channel = new MessageChannel();
          return [channel.port1, channel.port2] as const;
        })();
  const controller = new AbortController();
  return {
    left: port1,
    right: port2,
    codec: { encode: serialize, decode: (bytes) => deserialize(bytes) as unknown },
    failure: controller.signal,
    fail(error) {
      controller.abort(error);
    },
    close() {
      controller.abort(new Error("Transport rig closed"));
      port1.close();
      port2.close();
    },
  };
}
