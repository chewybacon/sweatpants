import { expect, it } from "vitest";
import { sqlCounter, sqlNatural } from "../sql-values.ts";

it("preserves SQL counters beyond JavaScript's safe integer range across driver representations", () => {
  for (const value of ["9007199254740993", 9007199254740993n, "9223372036854775807"]) {
    expect(sqlCounter(value).toString(10)).toBe(String(value));
  }
  expect(sqlCounter(0)).toBe(0n);
});

it.each([9007199254740992, "9223372036854775808", -1n, "1.5", "", "NaN"])(
  "rejects a lossy or out-of-range SQL counter %s",
  (value) => {
    expect(() => sqlCounter(value)).toThrow();
  },
);

it("normalizes safe SQL sizes and rejects oversized byte metadata", () => {
  expect([7, 7n, "7"].map((value) => sqlNatural(value, "stored_bytes"))).toEqual([7, 7, 7]);
  expect(() => sqlNatural(9007199254740993n, "stored_bytes")).toThrow("safe integer range");
});
