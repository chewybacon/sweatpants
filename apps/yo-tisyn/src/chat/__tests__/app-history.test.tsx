// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../App.tsx";

const chat = vi.hoisted(() => ({
  messages: [],
  status: "ready",
  sendMessage: vi.fn(),
  stop: vi.fn(),
  error: null,
  renderStatus: "ready",
  canSendMessage: false,
  history: { hasOlder: true, loadingOlder: false, error: null as Error | null },
  loadOlder: vi.fn(),
}));
vi.mock("@sweatpants/react-chat", async (original) => ({
  ...(await original<typeof import("@sweatpants/react-chat")>()),
  useChat: () => chat,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  chat.history.loadingOlder = false;
  chat.history.error = null;
});

it("offers history paging instead of empty-state examples for a restored conversation", () => {
  render(<App initialThreadId="history-test" />);
  expect(screen.queryByRole("heading", { name: "Choose a starting point" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load earlier activity" }));
  expect(chat.loadOlder).toHaveBeenCalledOnce();
});

it("disables duplicate history loads and surfaces paging errors", () => {
  chat.history.loadingOlder = true;
  chat.history.error = new Error("History could not be loaded");
  render(<App initialThreadId="history-test" />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Loading earlier activity…" }).disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe("History could not be loaded");
});
