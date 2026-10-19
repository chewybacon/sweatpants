import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeElicitCompletion } from "../program-driver-chat-settlement.ts";

describe("elicitation completion admission", () => {
  it("applies the authored transformation once and owns its output", () => {
    let transformations = 0;
    const output = { approved: true };
    const schema = z.string().transform(() => {
      transformations += 1;
      return output;
    });
    const completion = normalizeElicitCompletion(
      { action: "accept", content: "yes" },
      schema,
      "approval",
    );
    output.approved = false;
    expect(transformations).toBe(1);
    expect(completion).toEqual({ action: "accept", content: { approved: true } });
  });

  it("rejects invalid authored output even when the schema accepts the input", () => {
    const schema = z.string().transform(() => ({ approved: undefined }));
    expect(() =>
      normalizeElicitCompletion({ action: "accept", content: "yes" }, schema, "approval"),
    ).toThrow(/not JSON-serializable/);
  });

  it("validates content when no authored schema is installed", () => {
    expect(() =>
      normalizeElicitCompletion({ action: "accept", content: undefined }, undefined, "approval"),
    ).toThrow(/not JSON-serializable/);
    expect(
      normalizeElicitCompletion({ action: "accept", content: null }, undefined, "approval"),
    ).toEqual({ action: "accept", content: null });
  });

  it("does not apply the acceptance schema to cancellation or decline", () => {
    const schema = z.never();
    expect(normalizeElicitCompletion({ action: "cancel" }, schema, "approval")).toEqual({
      action: "cancel",
    });
    expect(normalizeElicitCompletion({ action: "decline" }, schema, "approval")).toEqual({
      action: "decline",
    });
    expect(() =>
      normalizeElicitCompletion({ action: "accept", content: "yes" }, schema, "approval"),
    ).toThrow(/validation failed/);
  });
});
