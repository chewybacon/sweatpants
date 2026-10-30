import { createConnection, createLocalTransport } from "@sweatpan.ts/connection";
import { MessageChannel } from "node:worker_threads";
import { serialize, deserialize } from "node:v8";
import type { Connection } from "@sweatpan.ts/connection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Operation } from "@standard-durability/core";
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

/** Acquire both peers in the caller's scope; the caller still owns the transport rig. */
export function* acquireConnections<Y>(
  runtime: Runtime<Y>,
  rig: TransportRig,
): Operation<readonly [Connection<Y>, Connection<Y>], Y> {
  const left = yield* createConnection(runtime, {
    transport: rig.left,
    codec: rig.codec,
    failure: rig.failure,
  });
  const right = yield* createConnection(runtime, {
    transport: rig.right,
    codec: rig.codec,
    failure: rig.failure,
  });
  return [left, right];
}
