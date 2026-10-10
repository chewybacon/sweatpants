import { createChatApp, inProcess } from "@sweatpants/agent-host/server";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { ToolExposurePolicyContext } from "@sweatpants/chat-core";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { assertJson, sha256 } from "@sweatpants/foundation";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import type { TestApplicationFactoryContext, TestApplication } from "@sweatpants/test-rig";
import { z } from "zod";

export const NESTED_PARENT_NAME = "nested_owner_parent";
export const NESTED_CHILD_NAME = "nested_owner_ask";

const child = createDurableTool(NESTED_CHILD_NAME)
  .description("Ask for a reply inside the parent tool")
  .identity({ version: "1", digest: sha256("nested-owner-ask-v1") })
  .parameters(z.object({}))
  .elicits({ reply: { response: z.object({ reply: z.string() }) } })
  .execute(function* (_input, context) {
    const response = yield* context.elicit("reply", { message: "Reply to the nested tool" });
    return assertJson(
      response.action === "accept"
        ? { reply: response.content.reply }
        : { action: response.action },
    );
  });

/** Real durable composition and provider client; the rig owns the provider's HTTP server. */
export function createNestedToolApplication(
  modelContext: TestApplicationFactoryContext,
  onRecordedWork: () => void,
): TestApplication {
  const parent = createDurableTool(NESTED_PARENT_NAME)
    .description("Record work, then invoke an interactive child")
    .identity({ version: "1", digest: sha256("nested-owner-parent-v1") })
    .parameters(z.object({}))
    .execute(function* (_input, context) {
      const callId = yield* context.record(
        { key: "before-child", retrySafety: { mode: "repeatable" } },
        function* (attempt) {
          onRecordedWork();
          return `${attempt.pullId}/ask`;
        },
      );
      // Exercise the existing authored lifecycle convention, not a new composition API.
      yield* context.emit("tool_started", { callId, tool: child.name, input: {} });
      const result = yield* context.pull({
        kind: "invoke",
        child: {
          id: child.manifest.programId,
          version: child.manifest.version,
          digest: child.manifest.digest,
          input: {},
        },
      });
      yield* context.emit("tool_completed", { callId, tool: child.name, result, failed: false });
      return result;
    });
  const app = createChatApp({
    name: "nested-tool-ownership",
    secret: "nested-tool-ownership-test-secret-only",
    storage: { kind: "memory" },
    tools: [parent, child],
    execution: inProcess(),
    model: {
      model: modelContext.model.model,
      driver: createPiAiModelProvider().driver,
      streamOptions: modelContext.model.streamOptions,
    },
    setup: {
      application: function* () {
        yield* setupDurableStreams({
          bufferStore: createInMemoryBufferStore<string>(),
          registryStore: createInMemoryRegistryStore(),
        });
      },
      chat: function* () {
        yield* ToolExposurePolicyContext.set({
          *filter({ entries }) {
            return (entries ?? [])
              .filter((entry) => entry.definition.name === parent.name)
              .map((entry) => entry.definition);
          },
        });
      },
    },
  });
  return { handle: app.handler, close: () => app.close() };
}
