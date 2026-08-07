import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";
import type { ChatContent } from "@sweatpants/chat-contract";

type Binding = TestRigOptions["binding"];

const multimodalParts = [
  { type: "text", text: "Inspect these media in order." },
  {
    type: "image",
    source: {
      type: "url",
      value: "https://example.test/image.png",
      mimeType: "image/png",
    },
    metadata: { detail: "high" },
  },
  {
    type: "audio",
    source: {
      type: "data",
      value: "QVVESU9fVjE=",
      mimeType: "audio/wav",
    },
  },
  {
    type: "video",
    source: {
      type: "url",
      value: "https://example.test/video.mp4",
      mimeType: "video/mp4",
    },
  },
  {
    type: "document",
    source: {
      type: "data",
      value: "RE9DVU1FTlRfVjE=",
      mimeType: "application/pdf",
    },
  },
] as unknown as ChatContent;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messages(value: unknown): readonly Record<string, unknown>[] {
  const input = record(value);
  return Array.isArray(input["messages"]) ? input["messages"].map(record) : [];
}

function assertOrderedMultimodalContent(value: unknown): void {
  const user = messages(value).find((message) => message["role"] === "user");
  expect(user?.["content"]).toEqual(multimodalParts);
}

async function runMultimodalScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation();
      yield* conversation.send({ content: multimodalParts });

      const started = yield* s.agui.event("RUN_STARTED");
      assertOrderedMultimodalContent(record(started)["input"]);

      const snapshot = yield* s.agui.event("MESSAGES_SNAPSHOT");
      assertOrderedMultimodalContent(snapshot);

      const finished = yield* s.agui.event("RUN_ERROR");
      expect(JSON.stringify(finished)).toContain("unsupported_model_capability");
      expect(s.model.requests()).toHaveLength(0);

      const reopened = yield* conversation.reopen();
      const replayed = JSON.stringify(reopened.snapshot().messages);
      const positions = [
        "Inspect these media in order.",
        "https://example.test/image.png",
        "QVVESU9fVjE=",
        "https://example.test/video.mp4",
        "RE9DVU1FTlRfVjE=",
      ].map((marker) => replayed.indexOf(marker));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    },
  );
}

describe("multimodal user message durability", () => {
  it.each(["in-process", "http"] as const)(
    "preserves ordered text, image, audio, video, and document parts %s",
    async (binding) => {
      await runMultimodalScenario(binding);
    },
    30_000,
  );
});
