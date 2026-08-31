import { describe, expect, it } from "vitest";
import { ephemeralDescriptorSchema } from "../pull-kinds/ephemeral.ts";

/**
 * REQ-014 — the durability vocabulary is exactly `opaque`, `ephemeral_handle`,
 * and `crank_native`. Descriptor validation rejects the removed
 * `resumable_handle` / `server_task` values. (Test plan TC-015.)
 */

const base = {
  kind: "ephemeral",
  driver: "tool-session",
  tool: "book_flight",
  input: {},
} as const;

function validate(durability: string): { ok: boolean } {
  const result = ephemeralDescriptorSchema.safeParse({ ...base, durability });
  return { ok: result.success };
}

describe("durability vocabulary contract", () => {
  it("accepts exactly the three surviving modes", () => {
    expect(validate("opaque").ok).toBe(true);
    expect(validate("ephemeral_handle").ok).toBe(true);
    expect(validate("crank_native").ok).toBe(true);
  });

  it("rejects the removed resumable_handle and server_task values", () => {
    expect(validate("resumable_handle").ok).toBe(false);
    expect(validate("server_task").ok).toBe(false);
  });
});
