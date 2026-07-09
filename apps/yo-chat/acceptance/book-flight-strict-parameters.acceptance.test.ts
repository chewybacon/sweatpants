import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  createLocalToolRuntimeDriver,
  createToolInventoryEntry,
} from "@sweatpants/tool-runtime-local";
import { bookFlightTool } from "../src/tools/book-flight/tool.ts";

describe("yo-chat book_flight strict parameter acceptance", () => {
  it("rejects missing required route params before starting the booking UI flow", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [bookFlightTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      try {
        yield* driver.execute({
          entry: createToolInventoryEntry(bookFlightTool),
          call: {
            id: "call-missing-origin",
            type: "function",
            function: { name: bookFlightTool.name, arguments: { destination: "NYC" } },
          },
        });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "TOOL_PARAMETER_VALIDATION_FAILED",
          payload: {
            toolName: "book_flight",
            callId: "call-missing-origin",
          },
        });
      }
    });
  });

  it("starts the authored flight picker flow when route params are complete", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [bookFlightTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      const result = yield* driver.execute({
        entry: createToolInventoryEntry(bookFlightTool),
        call: {
          id: "call-valid-route",
          type: "function",
          function: {
            name: bookFlightTool.name,
            arguments: { from: "Boston", destination: "NYC" },
          },
        },
      });

      expect(result).toMatchObject({ kind: "awaiting_elicit" });
      if (result.kind !== "awaiting_elicit")
        throw new Error("expected book_flight to request flight selection");
      expect(result.request).toMatchObject({ key: "pickFlight" });
      expect(result.request.message).toContain("Select a flight from Boston to NYC");
    });
  });
});
