import { documentEffectRegistration } from "./document-effect.ts";
import {
  createDecisionEffectRegistration,
  installDecisionProvider,
  type DecisionProviderDriver,
} from "@sweatpants/model-decision";
import { createChatApp } from "@sweatpants/agent-host/server";
import { ToolExposurePolicyContext } from "@sweatpants/chat-core";
import {
  setupDurableStreams,
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { programs, tisynExposure } from "../workflow/agent.ts";

type AppOptions = Parameters<typeof createChatApp>[0];

/** The same application runs in the local server and protocol test rig. */
export function createTisynApp(
  options: Pick<AppOptions, "storage" | "model" | "execution"> & {
    decisionProvider?: DecisionProviderDriver;
  },
) {
  return createChatApp({
    ...options,
    name: "yo-tisyn",
    secret: "yo-tisyn-local-spike-not-for-public-deployment",
    tools: programs,
    effects: [createDecisionEffectRegistration(), documentEffectRegistration],
    // Authoring and repair continue until completion or an explicit stop.
    maxToolIterations: null,
    setup: {
      application: function* () {
        if (options.decisionProvider) yield* installDecisionProvider(options.decisionProvider);
        yield* setupDurableStreams({
          bufferStore: createInMemoryBufferStore<string>(),
          registryStore: createInMemoryRegistryStore(),
        });
      },
      chat: function* () {
        // Child contracts stay installed; only model exposure is filtered.
        yield* ToolExposurePolicyContext.set(tisynExposure);
      },
    },
  });
}
