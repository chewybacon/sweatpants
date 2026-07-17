import {
  advertiseCapability,
  defineAgent,
  defineGuidance,
  defineResourcePackage,
  textResource,
} from "@sweatpants/core";
import { defineChatProgram, modelReadable, modelTool } from "@sweatpants/framework/chat";
import { echoMessageBinding } from "./echo-message.ts";
import { pickCardBinding } from "./pick-card.ts";

const cardResources = defineResourcePackage({
  id: "yo-a2a-card-guidance",
  version: "1.0.0",
  files: {
    "SKILL.md": textResource(
      "Use pick_card for card requests. Preserve selected-card results across turns. Use echo_message only for explicit echo requests.",
    ),
  },
});
export const cardGuidance = defineGuidance({
  id: "card-agent",
  summary: "Guidance for card draws, selections, and conversational memory.",
  package: cardResources,
  entryPath: "SKILL.md",
});

export const cardChat = defineChatProgram({
  identity: { name: "yo-a2a.card-chat", version: "1.0.0" },
  systemPrompt: {
    text: [
      "You are a durable card-drawing agent.",
      "When the user asks to draw or pick cards, call the pick_card tool.",
      "When the user asks to echo a message, call the echo_message tool.",
      "Pass the requested card count exactly; for 'draw 3 cards', call pick_card with count 3.",
      "Do not invent cards or ask the user to choose until the tool provides its elicitation.",
      "After the tool resumes, report the selected card.",
    ].join("\n"),
    classification: "internal",
  },
  guidance: [cardGuidance],
  resources: {
    cards: modelReadable(cardResources, { classification: "internal" }),
  },
  tools: {
    pick_card: modelTool(pickCardBinding, { resultClassification: "internal" }),
    echo_message: modelTool(echoMessageBinding, { resultClassification: "internal" }),
  },
  sampling: { toolChoice: "auto", maxTokens: 1_024 },
  maxIterations: 8,
});

export const cardAgent = defineAgent({
  identity: { name: "yo-a2a-cards", version: "1.0.0" },
  description: "A model-driven durable A2A agent that draws cards and elicits a selection.",
  conversation: cardChat,
  programs: {
    conversation: cardChat,
    pickCard: pickCardBinding,
    echoMessage: echoMessageBinding,
  },
  advertisedCapabilities: {
    cards: advertiseCapability({
      id: "cards",
      name: "Draw and pick cards",
      description: "Uses a model-selected durable tool to draw cards and request a user selection.",
      tags: ["cards", "durable-tool", "input-required"],
      examples: ["Draw 3 cards"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain", "application/json"],
      authorization: "local-demo",
    }),
  },
});
