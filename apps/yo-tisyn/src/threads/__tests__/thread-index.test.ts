// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readThreadIds, rememberThread } from "../thread-index.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

beforeEach(() => localStorage.clear());

describe("browser thread index", () => {
  it("keeps the previous conversation when a new thread becomes current", () => {
    // The current thread may predate the browser's recent-thread index.
    localStorage.setItem("yo-tisyn.thread", first);
    rememberThread(second);
    expect(readThreadIds()).toEqual([second, first]);
    rememberThread(first);
    rememberThread(second);
    expect(localStorage.getItem("yo-tisyn.thread")).toBe(second);
    expect(readThreadIds()).toEqual([second, first]);
    rememberThread(first);
    expect(readThreadIds()).toEqual([first, second]);
  });

  it("recovers a damaged index without losing the current thread", () => {
    localStorage.setItem("yo-tisyn.thread", first);
    localStorage.setItem("yo-tisyn.threads", "broken JSON");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readThreadIds()).toEqual([first]);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "[yo-tisyn] Could not read the browser thread index",
        expect.any(SyntaxError),
      );
    } finally {
      warning.mockRestore();
    }
    localStorage.setItem("yo-tisyn.threads", JSON.stringify([null, {}, first, "invalid", second]));
    expect(readThreadIds()).toEqual([first, second]);
  });
});
