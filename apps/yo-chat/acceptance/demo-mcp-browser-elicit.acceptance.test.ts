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
import { createLocalToolRuntimeDriver } from "@sweatpants/tool-runtime-local";

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
      });

      const callId = `mcp-call-${Date.now()}`;
      const session = yield* driver.startToolCall({
        toolName: "confirm_booking",
        callId,
        arguments: { trip: "BOS-NYC" },
      });

      // Drive until we see elicit_request (MCP call is in-flight)
      const events = yield* session.events();
      let elicitId: string | undefined;
      let sawElicit = false;

      // Bound wait — must not hang past harness policy
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const next = yield* events.next();
        if (next.done) break;
        const event = next.value as {
          type: string;
          elicitId?: string;
          key?: string;
        };
        if (event.type === "elicit_request") {
          sawElicit = true;
          elicitId = event.elicitId;
          expect(event.key).toBe("confirm");
          break;
        }
        if (event.type === "result" || event.type === "error") {
          throw new Error(`expected elicit before terminal event, got ${event.type}`);
        }
      }

      expect(sawElicit).toBe(true);
      expect(elicitId).toBeTruthy();

      // Human completes elicit in "browser" (answers the same elicit id)
      yield* driver.respondToElicit(
        { id: callId, runtimeId: "local", toolName: "confirm_booking" },
        elicitId!,
        { action: "accept", content: { confirmed: true } },
      );

      // MCP client receives coherent terminal tool result
      let terminal: { type: string; result?: unknown; error?: unknown } | undefined;
      const resultDeadline = Date.now() + 10_000;
      while (Date.now() < resultDeadline) {
        const next = yield* events.next();
        if (next.done) break;
        const event = next.value as { type: string; result?: unknown; error?: unknown };
        if (event.type === "result" || event.type === "error") {
          terminal = event;
          break;
        }
      }

      expect(terminal).toBeDefined();
      expect(terminal!.type).toBe("result");
      expect(terminal!.result).toMatchObject({ status: "booked", trip: "BOS-NYC" });
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
      });

      const callId = `mcp-decline-${Date.now()}`;
      const session = yield* driver.startToolCall({
        toolName: "confirm_booking",
        callId,
        arguments: { trip: "SFO-LAX" },
      });

      const events = yield* session.events();
      let elicitId: string | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const next = yield* events.next();
        if (next.done) break;
        const event = next.value as { type: string; elicitId?: string };
        if (event.type === "elicit_request") {
          elicitId = event.elicitId;
          break;
        }
      }
      expect(elicitId).toBeTruthy();

      yield* driver.respondToElicit(
        { id: callId, runtimeId: "local", toolName: "confirm_booking" },
        elicitId!,
        { action: "decline" },
      );

      let terminal: { type: string; result?: unknown } | undefined;
      const resultDeadline = Date.now() + 10_000;
      while (Date.now() < resultDeadline) {
        const next = yield* events.next();
        if (next.done) break;
        const event = next.value as { type: string; result?: unknown };
        if (event.type === "result" || event.type === "error") {
          terminal = event;
          break;
        }
      }

      expect(terminal).toBeDefined();
      expect(terminal!.type).toBe("result");
      expect(terminal!.result).toMatchObject({ status: "declined", trip: "SFO-LAX" });
    });
  }, 20_000);
});
