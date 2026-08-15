import { describe, expect, it } from "vitest";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { manifest, programDriverChatEngineSchemaEntries } from "./program-driver-schema.ts";

async function validateInput(value: unknown): Promise<unknown> {
  const binding = programDriverChatEngineSchemaEntries().find(
    (entry) => entry.descriptor.digest === manifest.inputSchema.digest,
  );
  if (!binding) throw new Error("chat-root input schema binding is missing");
  return await binding.schema["~standard"].validate(value);
}

function catalog(): { version: 1; digest: string; entries: Record<string, never> } {
  const entries: Record<string, never> = {};
  return {
    version: 1,
    digest: canonicalSnapshot({ version: 1, entries }).sha,
    entries,
  };
}

describe("chat-root durable semantic input", () => {
  it("accepts canonical ChatHistoryEntry composition", async () => {
    const result = await validateInput({
      contextSource: {
        type: "conversation",
        conversationId: "conversation-1",
        checkpoint: { checkpointId: "checkpoint-1" },
        acceptedCommandId: "command-1",
        executionId: "execution-1",
        taskId: "task-1",
        taskJournalFrontier: "current",
      },
      maxIterations: 1,
      catalog: catalog(),
    });
    expect(result).toHaveProperty("value");
  });

  it("rejects a full transcript task input before durable execution", async () => {
    const result = await validateInput({
      messages: [{ role: "user", content: "hello" }],
      maxIterations: 1,
      catalog: catalog(),
    });
    expect(result).toHaveProperty("issues");
  });
});
