// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../App.tsx";
import type { ReactChatUIMessage } from "@sweatpants/react-chat";
import { emptyFrame } from "@sweatpants/frame-renderer";

const chat = vi.hoisted(() => ({
  messages: [] as ReactChatUIMessage[],
  status: "ready",
  sendMessage: vi.fn(),
  stop: vi.fn(),
  error: null,
  renderStatus: "ready",
  canSendMessage: false,
  authority: undefined as undefined | { state: "parked" },
  connectionStatus: "disconnected",
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
  chat.messages = [];
  chat.authority = undefined;
});

it("shows a parked question while its response stream is normally disconnected", () => {
  chat.authority = { state: "parked" };
  chat.messages = [
    {
      id: "question",
      role: "assistant",
      metadata: {},
      parts: [
        {
          id: "ask",
          type: "elicit",
          elicitId: "e",
          bindingId: "b",
          key: "reply",
          message: "Next?",
          state: "pending",
          parts: [],
        },
      ],
    },
  ];
  render(<App initialThreadId="history-test" />);
  expect(screen.getByRole("status").textContent).toBe("Waiting for input");
  expect(screen.queryByText("Disconnected")).toBeNull();
});

it("omits empty and opaque messages, and shows a card when content arrives", () => {
  chat.messages = [
    { id: "empty", role: "assistant", parts: [], metadata: {} },
    {
      id: "empty-text",
      role: "assistant",
      metadata: {},
      parts: [
        {
          id: "text",
          type: "text",
          state: "streaming",
          text: "",
          rendered: "",
          frame: emptyFrame(),
        },
      ],
    },
    {
      id: "opaque",
      role: "assistant",
      metadata: {},
      parts: [
        {
          id: "activity",
          type: "activity",
          activityType: "sample",
          presentation: "opaque",
          state: "complete",
          parts: [],
        },
      ],
    },
    {
      id: "nested",
      role: "assistant",
      metadata: {},
      parts: [
        {
          id: "nested-part",
          type: "message",
          message: { id: "child", role: "assistant", metadata: {}, parts: [] },
        },
      ],
    },
  ];
  const view = render(<App initialThreadId="history-test" />);
  expect(view.container.querySelectorAll(".message-card")).toHaveLength(0);
  chat.messages = [
    {
      id: "empty",
      role: "assistant",
      metadata: {},
      parts: [
        {
          id: "tool",
          type: "tool-call",
          callId: "call",
          name: "echo",
          state: "input-available",
          input: { message: "hello" },
          parts: [],
        },
      ],
    },
  ];
  view.rerender(<App initialThreadId="history-test" />);
  expect(view.container.querySelectorAll(".message-card")).toHaveLength(1);
  expect(screen.getByText("Assistant")).toBeTruthy();
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
