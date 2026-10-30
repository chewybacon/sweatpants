import { useAbortSignal } from "effection";
import type { ModelProviderDriver } from "../../packages/model-provider/src/index.ts";
import type { PendingJournal } from "@sweatpants/foundation/journal";
import type { TurnInput } from "../../packages/agent-host/src/primitive/activation.ts";
import { effection, type EffectionYield } from "@sweatpants/standard-durability-effection";
import { createScopedChat, type ScopedChatCapabilities, type TypedChatEvents } from "./chat.ts";
import type { Operations, Signature } from "@sweatpants/standard-durability";
import { ModelDefinition } from "./model-api.ts";
import { modelOutcome } from "./model-api.ts";

/** Native implementation of the declared Model API, installed by its caller's scope. */
export function createEffectionModelOperations(
  chat: Pick<ReturnType<typeof createScopedChat<EffectionYield>>, "ModelConfig" | "Output">,
  driver: ModelProviderDriver,
): Operations<Signature<typeof ModelDefinition.operations>, EffectionYield> {
  return {
    *sample(context) {
      const { model, streamOptions } = yield* chat.ModelConfig.expect();
      const scopeSignal = yield* useAbortSignal();
      const signal = streamOptions?.signal
        ? AbortSignal.any([scopeSignal, streamOptions.signal])
        : scopeSignal;
      const stream = yield* driver.stream({
        model,
        context,
        options: { ...streamOptions, signal },
      });
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        // Publication middleware must finish before consuming another native event.
        yield* chat.Output.operations.publish(next.value);
        next = yield* subscription.next();
      }
      return modelOutcome(next.value);
    },
  };
}

/** Bind an existing native provider; the journal and model configuration remain caller-owned. */
export function createEffectionProviderChat(driver: ModelProviderDriver) {
  const chat = createScopedChat(effection);
  return {
    ...chat,
    activate(
      capabilities: ScopedChatCapabilities<EffectionYield>,
      input: TurnInput,
      journal: PendingJournal,
      events: TypedChatEvents = {},
    ) {
      return effection.scoped(function* () {
        yield* chat.Model.host.install(createEffectionModelOperations(chat, driver));
        return yield* chat.activate(capabilities, input, journal, events);
      });
    },
  };
}
