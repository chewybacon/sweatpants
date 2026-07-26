import { describe, expect, it } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../src/index.ts";

function testToolContext() {
  return {
    messages: [] as const,
    elicit: (() => {
      throw new Error("not used");
    }) as never,
    elicitDynamic: (() => {
      throw new Error("not used");
    }) as never,
    sample: (() => {
      throw new Error("not used");
    }) as never,
    notify: function* () {},
    log: function* () {},
  };
}

describe("@sweatpants/core strict tool parameter acceptance", () => {
  it("rejects invalid required params before implementation and executes valid params", function* () {
    let implementationCalls = 0;
    let observedParams: unknown;

    const BookFlight = createTool("book_flight")
      .description("Book a flight")
      .parameters(
        z.object({
          from: z.string(),
          destination: z.string(),
        }),
      )
      .elicits({})
      .execute(function* (params) {
        implementationCalls += 1;
        observedParams = params;
        return { ok: true, route: `${params.from}-${params.destination}` };
      });

    const invoke = yield* BookFlight(testToolContext());

    try {
      yield* invoke({ destination: "NYC" } as unknown as { from: string; destination: string });
      throw new Error("expected strict parameter validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Invalid input for tool "book_flight"');
    }

    expect(implementationCalls).toBe(0);

    const result = yield* invoke({ from: "Boston", destination: "NYC" });
    expect(result).toEqual({ ok: true, route: "Boston-NYC" });
    expect(implementationCalls).toBe(1);
    expect(observedParams).toEqual({ from: "Boston", destination: "NYC" });
  });
});
