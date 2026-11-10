import type {
  AssistantMessage,
  Context,
  Model,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import type { Json, ModelContext, ModelUsage } from "@sweatpan.ts/providers";
import { decodeAssistantContent, piContentSchema } from "./decode.ts";

export const contextUsageFormat = "sweatpants/pi-context-usage/2";

/** Hash the normalized native transcript, excluding SDK telemetry and timestamps.
 * This checks estimate validity, not authority or authentication. */
export async function contextUsageKey(
  context: TranscriptContext,
  model: Model<string>,
): Promise<string> {
  const messages = context.messages.map((message) => {
    if (message.role === "assistant") {
      return { role: message.role, content: piContentSchema.parse(message.content) };
    }
    const { timestamp: _timestamp, ...visible } = message;
    return visible;
  });
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      model: { id: model.id, api: model.api, provider: model.provider, baseUrl: model.baseUrl },
      messages,
    }),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Preserve native response content that canonical text cannot represent. */
export function contextUsageData(result: AssistantMessage): Json {
  return JSON.parse(JSON.stringify(piContentSchema.parse(result.content)));
}

/** Restore native content only while its canonical projection is unchanged.
 * Host preparation runs afterward, so any further native edits enter the hash. */
export function restoreNativeContent(context: Context, original: ModelContext): void {
  const assistants = original.messages.filter((message) => message.role === "assistant");
  let ordinal = 0;
  for (const message of context.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const original = assistants[ordinal++];
    const stamp = original?.contextUsage;
    if (stamp?.basis.format !== contextUsageFormat) {
      continue;
    }
    const parsed = piContentSchema.safeParse(stamp.basis.data);
    if (
      parsed.success &&
      JSON.stringify(decodeAssistantContent({ content: parsed.data }).content) ===
        JSON.stringify(original?.content)
    ) {
      message.content = parsed.data;
    }
  }
}

function piUsage(usage: ModelUsage): Usage | undefined {
  const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (
    [usage.total, ...fields].some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    )
  ) {
    return undefined;
  }
  // A missing total is usable only if every non-overlapping component is known.
  if (usage.total === null && fields.some((value) => value === null)) {
    return undefined;
  }
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.total ?? fields.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    // Context estimation does not use historical billing data.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Restore only the newest retained stamp against the prepared native prefix. */
export async function restoreContextUsage(
  context: TranscriptContext,
  original: ModelContext,
  model: Model<string>,
): Promise<void> {
  const assistants = original.messages.filter((message) => message.role === "assistant");
  let ordinal = assistants.length;
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const stamp = assistants[--ordinal]?.contextUsage;
    if (!stamp) {
      continue;
    }
    if (stamp.basis.format !== contextUsageFormat) {
      return;
    }
    const usage = piUsage(stamp.usage);
    if (
      usage &&
      stamp.basis.key ===
        (await contextUsageKey(
          { ...context, messages: context.messages.slice(0, index + 1) },
          model,
        ))
    ) {
      message.usage = usage;
    }
    return;
  }
}
