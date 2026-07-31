import {
  createChatModelEffectRegistration,
  type AuthoredChatMessage,
  type AuthoredChatModelSampleResult,
} from "@sweatpants/chat-core";
import type { Json } from "@sweatpants/foundation";
import { cardGuidance } from "./agent.ts";

/** Deterministic deployment binding used only by required browser/CI certification. */
export const scriptedModelRegistration = createChatModelEffectRegistration({
  allowedClassifications: ["public", "internal"],
  *sample(request, effect) {
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    const latestTool = toolMessages.at(-1);
    const latestTarget = latestTool ? toolTarget(latestTool) : undefined;
    if (latestTool && latestTarget !== "resources.read") {
      const result = toolResult(latestTool);
      return answer(effect.pullId, `Tool completed: ${result}`);
    }
    const reversedMessages = [...request.messages];
    // oxlint-disable-next-line unicorn/no-array-reverse -- package target is ES2022.
    reversedMessages.reverse();
    const userText =
      reversedMessages
        .find((message) => message.role === "user")
        ?.parts.map((part) => String(part.value))
        .join(" ") ?? "";
    if (userText.includes("FAIL_SAFE")) {
      throw new Error("PRIVATE_SCRIPTED_PROVIDER_SENTINEL");
    }
    if (!latestTool) {
      return call(effect.pullId, "resources.read", { uri: cardGuidance.entryUri });
    }
    if (/echo/i.test(userText)) {
      return call(effect.pullId, "echo_message", {});
    }
    const flightMatch = /book\s+a?\s*flight\s+from\s+(\S+)\s+to\s+(\S+)/i.exec(userText);
    if (flightMatch) {
      return call(effect.pullId, "book_flight", {
        from: flightMatch[1]!,
        destination: flightMatch[2]!,
      });
    }
    if (/draw|pick\s+(?:a\s+)?card/i.test(userText)) {
      const requested = Number(userText.match(/\b(\d+)\b/)?.[1] ?? 2);
      return call(effect.pullId, "pick_card", {
        count: Math.max(2, Math.min(10, requested)),
      });
    }
    const selected = request.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .map((part) => String(part.value))
      .filter((value) => /selected/i.test(value));
    return answer(
      effect.pullId,
      selected.length > 0
        ? `Conversation memory: ${selected.join("; ")}`
        : `Conversation response: ${userText}`,
    );
  },
});

function call(pullId: string, target: string, input: Json): AuthoredChatModelSampleResult {
  return {
    message: assistant(`call-${pullId}`, `Calling ${target}`),
    calls: [{ id: `tool-${pullId}`, target, input }],
    artifacts: [],
  };
}
function answer(pullId: string, text: string): AuthoredChatModelSampleResult {
  return { message: assistant(`answer-${pullId}`, text), calls: [], artifacts: [] };
}
function assistant(id: string, value: string): AuthoredChatMessage {
  return {
    id,
    role: "assistant",
    parts: [{ value, provenance: { classifications: [], sourceDigests: [] } }],
  };
}
function toolTarget(message: AuthoredChatMessage): string | undefined {
  const value = message.parts[0]?.value;
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value["target"] === "string"
    ? value["target"]
    : undefined;
}
function toolResult(message: AuthoredChatMessage): string {
  const value = message.parts[0]?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return String(value);
  }
  const result = value["result"];
  return typeof result === "string" ? result : JSON.stringify(result);
}
