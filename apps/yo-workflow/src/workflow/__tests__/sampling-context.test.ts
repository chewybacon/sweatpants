import { expect, it } from "vitest";
import { run } from "effection";
import { sampleCompletion } from "../sampling.ts";

it("sends only explicitly selected JSON context to a sample", async () => {
  const requests: unknown[] = [];
  await run(() =>
    sampleCompletion(
      {
        prompt: "Choose an available action.",
        context: { visible: [1, 2], history: [{ action: 1 }] },
      },
      {
        *sample(request) {
          requests.push(request);
          return { text: "2" };
        },
      },
    ),
  );
  expect(requests).toEqual([
    {
      prompt:
        'Choose an available action.\n\nExplicit context (JSON data):\n{"history":[{"action":1}],"visible":[1,2]}',
      maxTokens: 4096,
    },
  ]);
});

it("bounds the combined prompt and context before sampling", async () => {
  await expect(
    run(() =>
      sampleCompletion(
        { prompt: "x", context: "x".repeat(32768) },
        {
          *sample() {
            throw new Error("Unexpected model call");
          },
        },
      ),
    ),
  ).rejects.toThrow("32 KiB");
});
