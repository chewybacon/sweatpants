import type { Operation } from "effection";
import { advertiseCapability, defineAgent } from "@sweatpants/agent-sdk";
import {
  createChatModelEffectRegistration,
  defineChatProgram,
  latestContextWindow,
  type AuthoredChatModelSampleRequest,
  type AuthoredChatModelSampleResult,
} from "@sweatpants/chat-core";
import { createStandardA2AHost, serveAgent, standardA2A } from "@sweatpants/agent-host/server";
import { createPiAiModelProviderDriver } from "@sweatpants/model-provider-pi-ai";
import type {
  AssistantMessage,
  Context,
  PortableModelContextMessage,
} from "@sweatpants/model-provider";
import type { TestApplication, TestApplicationFactoryContext } from "@sweatpants/test-rig";

export const ACCEPTANCE_AGENT_MODEL_ID = "a2a-agent-acceptance";

const conversation = defineChatProgram({
  identity: { name: "acceptance.standard-agent.chat", version: "1" },
  systemPrompt: { text: "Answer as the deterministic acceptance agent", classification: "public" },
  contextPolicy: latestContextWindow(),
});

const agent = defineAgent({
  identity: { name: "acceptance-standard-agent", version: "1" },
  description: "Standard A2A acceptance agent",
  conversation,
  programs: { conversation },
  advertisedCapabilities: {
    chat: advertiseCapability({
      id: "chat",
      name: "Chat",
      description: "Deterministic acceptance chat",
      tags: ["acceptance"],
      examples: ["hello agent"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      authorization: "anonymous-test",
    }),
  },
});

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function toModelMessages(request: AuthoredChatModelSampleRequest): PortableModelContextMessage[] {
  return request.messages.map((message) => {
    const content = message.parts.map((part) => text(part.value)).join("");
    if (message.role === "system") {
      return { role: "system", content };
    }
    if (message.role === "user") {
      return { role: "user", content };
    }
    return { role: "assistant", content: [{ type: "text", text: content }] };
  });
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter(
      (part): part is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

export function createAcceptanceStandardAgent(
  context: TestApplicationFactoryContext,
): TestApplication {
  const driver = createPiAiModelProviderDriver();
  const model = createChatModelEffectRegistration({
    allowedClassifications: ["public"],
    *sample(request): Operation<AuthoredChatModelSampleResult> {
      const modelContext: Context = {
        messages: toModelMessages(request),
        systemPrompt: text(request.systemPrompt.value),
      };
      const assistant = yield* driver.sample({
        model: context.model.model,
        context: modelContext,
        options: context.model.streamOptions,
      });
      return {
        message: {
          id: `agent-answer-${crypto.randomUUID()}`,
          role: "assistant",
          parts: [
            {
              value: assistantText(assistant),
              provenance: { classifications: [], sourceDigests: [] },
            },
          ],
        },
        calls: [],
        artifacts: [],
      };
    },
  });
  const served = serveAgent(
    agent,
    standardA2A({
      deployment: {
        interfaceUrl: "http://127.0.0.1/a2a",
        insecureLoopbackDevelopment: true,
      },
      handlers: [model],
      capabilityBindings: {},
      host: createStandardA2AHost({ allowAnonymousDevelopment: true }),
    }),
  );
  const host = served.host;
  if (!host || !("handle" in host)) {
    throw new Error("Acceptance standard A2A host did not bind");
  }
  return {
    handle: (request) => host.handle(request),
    close: async () => {},
  };
}
