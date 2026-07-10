/**
 * Differentiator demo acceptance: MCP tool → browser elicit → MCP result (REQ-023).
 *
 * An external MCP client invokes a tool that elicits (browser HITL).
 * The MCP tool call remains in-flight until the human completes the elicit,
 * then returns a coherent tool result (success or structured cancellation).
 *
 * Classification: acceptance (protocol/bridge).
 * Uses product `createTool` + canonical local tool runtime wiring
 * (same path as yo-chat MCP plugin tools).
 */
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import { createToolInventoryEntry } from "@sweatpants/framework/chat";
import { createLocalToolRuntimeDriver } from "@sweatpants/tool-runtime-local";
import { yoChatTestToolSessionWorkerConfig } from "../src/server/tool-worker-config.ts";

/**
 * Minimal tool that always elicits once, then returns based on the answer.
 * Mirrors the product createTool + elicit authoring path used by yo-chat plugins.
 */
const confirmBookingTool = createTool("confirm_booking")
  .description("Confirm a booking via browser elicit")
  .parameters(z.object({ trip: z.string() }))
  .elicits({
    confirm: {
      response: z.object({ confirmed: z.boolean() }),
    },
  })
  .execute(function* (params, ctx) {
    const response = yield* ctx.elicit("confirm", {
      message: `Confirm booking for ${params.trip}?`,
    });

    if (response.action === "accept" && response.content?.confirmed) {
      return { status: "booked", trip: params.trip };
    }
    if (response.action === "decline") {
      return { status: "declined", trip: params.trip };
    }
    return { status: "cancelled", trip: params.trip };
  });

describe("demo: MCP tool → browser elicit → MCP result", () => {
  it("blocks MCP call until browser elicit completes, then returns coherent result", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [confirmBookingTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: yoChatTestToolSessionWorkerConfig },
      });

      const initial = yield* driver.execute({
        entry: createToolInventoryEntry(confirmBookingTool),
        call: {
          id: `mcp-call-${Date.now()}`,
          type: "function",
          function: { name: "confirm_booking", arguments: { trip: "BOS-NYC" } },
        },
      });

      expect(initial).toMatchObject({ kind: "awaiting_elicit" });
      if (initial.kind !== "awaiting_elicit") {
        throw new Error(`expected elicit before terminal result, got ${initial.kind}`);
      }
      expect(initial.request.key).toBe("confirm");

      // Human completes elicit in "browser" (answers the same elicit id)
      const terminal = yield* driver.resume({
        ref: initial.ref,
        input: {
          type: "elicit_response",
          elicitId: initial.request.elicitId,
          result: { action: "accept", content: { confirmed: true } },
        },
      });

      expect(terminal).toMatchObject({
        kind: "completed",
        result: { status: "booked", trip: "BOS-NYC" },
      });
    });
  }, 20_000);

  it("returns structured cancellation when elicit is declined", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [confirmBookingTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: yoChatTestToolSessionWorkerConfig },
      });

      const initial = yield* driver.execute({
        entry: createToolInventoryEntry(confirmBookingTool),
        call: {
          id: `mcp-decline-${Date.now()}`,
          type: "function",
          function: { name: "confirm_booking", arguments: { trip: "SFO-LAX" } },
        },
      });

      expect(initial).toMatchObject({ kind: "awaiting_elicit" });
      if (initial.kind !== "awaiting_elicit") throw new Error("expected pending elicitation");

      const terminal = yield* driver.resume({
        ref: initial.ref,
        input: {
          type: "elicit_response",
          elicitId: initial.request.elicitId,
          result: { action: "decline" },
        },
      });

      expect(terminal).toMatchObject({
        kind: "completed",
        result: { status: "declined", trip: "SFO-LAX" },
      });
    });
  }, 20_000);
});
