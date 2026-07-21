import { createContext, type Operation, type Stream } from "effection";
import {
  TransportContext,
  type CorrelatedTransport,
  type TransportRequest,
  type NotifyResponse,
} from "@sweatpants/core";

export interface FrameworkBridgeConfig {
  callId: string;
}
export const FrameworkBridgeContext = createContext<FrameworkBridgeConfig>("framework-bridge");

function createFrameworkTransport(): CorrelatedTransport {
  return {
    request<TProgress, TResponse>(message: TransportRequest) {
      return {
        *[Symbol.iterator]() {
          if (message.kind === "notify") {
            const response: NotifyResponse = { ok: true };
            return response as TResponse;
          }
          throw new Error(`Unsupported transport request kind: ${message.kind}`);
        },
      } as unknown as Stream<TProgress, TResponse>;
    },
  };
}

export function* withFrameworkTransport<T>(
  callId: string,
  operation: () => Operation<T>,
): Operation<T> {
  const config = { callId };
  return yield* FrameworkBridgeContext.with(config, function* () {
    return yield* TransportContext.with(createFrameworkTransport(), operation);
  });
}
