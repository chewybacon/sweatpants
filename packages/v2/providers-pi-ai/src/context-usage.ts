import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ModelContext, ModelUsage } from "@sweatpan.ts/providers";

export const contextUsageFormat = "sweatpants/pi-context-usage/1";

/** Hash provider-visible canonical data, excluding accounting and chat bookkeeping.
 * This is an estimate validity check, never journal authority or authentication. */
export async function contextUsageKey(
  context: ModelContext,
  model: Model<string>,
): Promise<string> {
  const messages = context.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId,
        name: message.name,
        isError: message.isError,
      };
    }
    return { role: message.role, content: message.content };
  });
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      model: { id: model.id, api: model.api, provider: model.provider, baseUrl: model.baseUrl },
      messages,
      tools: context.tools,
    }),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

/** Reuse only the newest retained stamp, and only against its exact current prefix.
 * A changed prefix falls back to local estimation, without searching older stamps. */
export async function restoreContextUsage(
  context: ModelContext,
  model: Model<string>,
): Promise<Map<number, Usage>> {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "assistant" || !message.contextUsage) {
      continue;
    }
    const stamp = message.contextUsage;
    if (stamp.basis.format !== contextUsageFormat) {
      return new Map();
    }
    const usage = piUsage(stamp.usage);
    if (
      !usage ||
      stamp.basis.key !==
        (await contextUsageKey(
          { ...context, messages: context.messages.slice(0, index + 1) },
          model,
        ))
    ) {
      return new Map();
    }
    return new Map([[index, usage]]);
  }
  return new Map();
}
