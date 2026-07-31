import { describe, expect, it } from "vitest";
import { createAgUiProbe } from "./ag-ui.ts";

function ndjson(events: unknown[]): Response {
  return new Response(
    events.map((event, index) => JSON.stringify({ lsn: index + 1, event })).join("\n") + "\n",
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
}

describe("passive AG-UI conformance probe", () => {
  it("validates the lifecycle emitted on a real response body", async () => {
    const probe = createAgUiProbe((error) => {
      throw error;
    });
    const response = probe.observe(
      ndjson([
        { type: "RUN_STARTED", threadId: "thread", runId: "run" },
        { type: "TEXT_MESSAGE_START", messageId: "assistant", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant", delta: "hello" },
        { type: "TEXT_MESSAGE_END", messageId: "assistant" },
        { type: "RUN_FINISHED", threadId: "thread", runId: "run" },
      ]),
    );

    await response.text();
    await probe.settle();
    probe.assertConformant();
    expect(probe.events().map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  it("rejects obsolete output from the application", async () => {
    let failure: Error | undefined;
    const probe = createAgUiProbe((error) => {
      failure = error;
    });
    const response = probe.observe(ndjson([{ type: "ag_ui_checkpoint" }]));

    await expect(response.text()).rejects.toThrow();
    await expect(probe.settle()).rejects.toThrow();
    expect(failure?.message).toContain("Obsolete AG-UI event emitted");
  });
});
