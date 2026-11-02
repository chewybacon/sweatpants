import { scoped, useAbortSignal } from "effection";
import type { EffectionYield } from "@sweatpants/runtime-effection";
import type { Identity } from "@sweatpants/foundation/journal";
import type { Model, ModelProviderDriver } from "@sweatpants/model-provider";
import type { ChatModelStream, ChatCapabilities } from "./chat.ts";

export interface PrimitiveChatOptions extends Omit<ChatCapabilities<EffectionYield>, "model"> {
  database: string;
  basePath?: string;
  program: Identity["program"];
  model: Omit<ChatCapabilities<EffectionYield>["model"], "driver"> & {
    /** Pinned configuration identity, excluding credentials. */
    identity: string;
    driver: ModelProviderDriver;
    select?(selection: unknown): string;
    resolve?(identity: string): Model;
  };
  authorize(request: Request, conversationId: string): boolean | Promise<boolean>;
}

/** The acquisition scope owns the native subscription and drains it before returning. */
export function effectionModelStream(driver: ModelProviderDriver): ChatModelStream<EffectionYield> {
  return {
    *stream(request, publish) {
      return yield* scoped(function* () {
        const signal = yield* useAbortSignal();
        const stream = yield* driver.stream({
          ...request,
          options: { ...request.options, signal },
        });
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          publish(next.value);
          next = yield* subscription.next();
        }
        return next.value;
      });
    },
  };
}
