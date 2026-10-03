import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useThreadMetadata } from "../use-thread-metadata";

// The Vite SSR loader and testing-library's CommonJS renderer must share React's dispatcher.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const react = createRequire(import.meta.url)("react");
  return { ...react, default: react };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("coalesces token updates, flushes completion, and ignores transcript changes outside the preview", () => {
  vi.useFakeTimers();
  const onMetadata = vi.fn<Parameters<typeof useThreadMetadata>[0]["onMetadata"]>();
  const base = {
    threadId: "one",
    ready: true,
    busy: true,
    onMetadata,
    summary: { title: "Question", lastMessagePreview: "H", messageCount: 2 },
  };
  const { rerender } = renderHook(useThreadMetadata, { initialProps: base });
  for (const text of ["He", "Hel", "Hell", "Hello"]) {
    act(() => vi.advanceTimersByTime(40));
    rerender({ ...base, summary: { ...base.summary, lastMessagePreview: text } });
  }
  expect(onMetadata).not.toHaveBeenCalled();
  const completed = {
    ...base,
    busy: false,
    summary: { ...base.summary, lastMessagePreview: "Hello" },
  };
  rerender(completed);
  expect(onMetadata).toHaveBeenCalledExactlyOnceWith("one", completed.summary);
  rerender({ ...completed, summary: { ...completed.summary } });
  act(() => vi.advanceTimersByTime(1000));
  expect(onMetadata).toHaveBeenCalledTimes(1);
});

it("does not erase metadata during hydration or send a delayed update after switching threads", () => {
  vi.useFakeTimers();
  const onMetadata = vi.fn<Parameters<typeof useThreadMetadata>[0]["onMetadata"]>();
  const base = {
    threadId: "old",
    ready: false,
    busy: false,
    onMetadata,
    summary: { title: "New thread", lastMessagePreview: "No messages yet", messageCount: 0 },
  };
  const { rerender, unmount } = renderHook(useThreadMetadata, { initialProps: base });
  expect(onMetadata).not.toHaveBeenCalled();
  rerender({ ...base, ready: true, busy: true });
  rerender({
    ...base,
    threadId: "new",
    ready: true,
    summary: { ...base.summary, title: "New conversation" },
  });
  expect(onMetadata).toHaveBeenCalledTimes(1);
  expect(onMetadata.mock.calls[0]?.[0]).toBe("new");
  unmount();
  act(() => vi.advanceTimersByTime(1000));
  expect(onMetadata).toHaveBeenCalledTimes(1);
});
