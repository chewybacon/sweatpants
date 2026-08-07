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
      messages: [
        {
          type: "message",
          id: "history-1",
          message: { role: "user", content: "hello" },
          metadata: {},
        },
      ],
      maxIterations: 1,
      catalog: catalog(),
    });
    expect(result).toHaveProperty("value");
  });

  it("rejects broad old message records before durable execution", async () => {
    const result = await validateInput({
      messages: [{ role: "user", content: "hello" }],
      maxIterations: 1,
      catalog: catalog(),
    });
    expect(result).toHaveProperty("issues");
  });
});
