import type { PublicProjectionRoot } from "@sweatpants/chat-core";
import { assertJson } from "@sweatpants/foundation";
import { rootPayloadBytes } from "@sweatpants/history-store";
import { describe, expect, it } from "vitest";
import { spillRoots } from "../checkpoint-spill.ts";

function root(
  position: number,
  state: "mutable" | "sealed",
  content = "hello",
): PublicProjectionRoot {
  return {
    rootId: `message:${position}`,
    position: String(position),
    kind: "message",
    state,
    attribution: {},
    message: { id: String(position), role: "assistant", content },
    placement: { type: "root", sequence: position },
  };
}

describe("checkpoint spill policy", () => {
  it("spills the oldest sealed roots under count pressure without moving mutable roots", () => {
    const roots = [
      root(0, "mutable"),
      root(1, "sealed"),
      root(2, "mutable"),
      root(3, "sealed"),
      root(4, "sealed"),
    ];
    const before = structuredClone(roots);
    const result = spillRoots(roots, { maxRoots: 3, maxEncodedBytes: Infinity });
    expect(result.spilled).toEqual([roots[1], roots[3]]);
    expect(result.hotRoots).toEqual([roots[0], roots[2], roots[4]]);
    expect(roots).toEqual(before);
  });

  it("retains exact count and byte thresholds using the sum of UTF-8 root payloads", () => {
    const roots = [root(0, "sealed", "😀漢é"), root(1, "sealed", '\\"\n')];
    const bytes = rootPayloadBytes(roots.map((value) => assertJson(value)));
    const exact = spillRoots(roots, { maxRoots: 2, maxEncodedBytes: bytes });
    expect(exact.spilled).toEqual([]);
    expect(exact.hotRoots).toEqual(roots);
    const below = spillRoots(roots, { maxRoots: 2, maxEncodedBytes: bytes - 1 });
    expect(below.spilled).toEqual([roots[0]]);
    expect(below.hotRoots).toEqual([roots[1]]);
  });

  it("subtracts only the removed sealed root while byte pressure skips mutable roots", () => {
    const roots = [
      root(0, "mutable", "😀".repeat(20)),
      root(1, "sealed", "a".repeat(300)),
      root(2, "mutable"),
      root(3, "sealed", "漢".repeat(100)),
      root(4, "sealed", "last"),
    ];
    const retained = [roots[0]!, roots[2]!, roots[4]!];
    const result = spillRoots(roots, {
      maxRoots: roots.length,
      maxEncodedBytes: rootPayloadBytes(retained.map((value) => assertJson(value))),
    });
    expect(result.spilled).toEqual([roots[1], roots[3]]);
    expect(result.hotRoots).toEqual(retained);
  });

  it("continues from count pressure into byte pressure with the same ordering", () => {
    const roots = [
      root(0, "sealed"),
      root(1, "mutable"),
      root(2, "sealed"),
      root(3, "sealed"),
      root(4, "sealed"),
    ];
    const result = spillRoots(roots, {
      maxRoots: 3,
      maxEncodedBytes: rootPayloadBytes([assertJson(roots[1]), assertJson(roots[4])]),
    });
    expect(result.spilled).toEqual([roots[0], roots[2], roots[3]]);
    expect(result.hotRoots).toEqual([roots[1], roots[4]]);
  });

  it("leaves unavoidable pressure for checkpoint admission when no sealed roots remain", () => {
    const roots = [root(0, "mutable"), root(1, "mutable")];
    expect(spillRoots(roots, { maxRoots: 0, maxEncodedBytes: 0 })).toEqual({
      spilled: [],
      hotRoots: roots,
    });
    expect(spillRoots(roots, { maxRoots: 2, maxEncodedBytes: 0 })).toEqual({
      spilled: [],
      hotRoots: roots,
    });
    expect(spillRoots([], { maxRoots: 0, maxEncodedBytes: 0 })).toEqual({
      spilled: [],
      hotRoots: [],
    });
  });

  it("can spill every sealed root when no root fits", () => {
    const roots = [root(0, "sealed"), root(1, "sealed")];
    expect(spillRoots(roots, { maxRoots: 2, maxEncodedBytes: 0 })).toEqual({
      spilled: roots,
      hotRoots: [],
    });
  });
});
