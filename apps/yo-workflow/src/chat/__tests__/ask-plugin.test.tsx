import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReplyForm } from "../ask-plugin.tsx";
import type { Reply } from "../reply.tsx";

afterEach(cleanup);

describe("Ask option buttons", () => {
  it("offers each move as an editable reply and submits only after confirmation", () => {
    const replies: Reply[] = [];
    render(
      <ReplyForm
        prompt="Your move?"
        suggestions={["Paper", "Rock", "Scissors"]}
        onRespond={(reply) => replies.push(reply)}
      />,
    );
    for (const move of ["Paper", "Rock", "Scissors"]) {
      fireEvent.click(screen.getByRole("button", { name: move }));
      expect(screen.getByLabelText<HTMLTextAreaElement>("Your reply").value).toBe(move);
      expect(document.activeElement).toBe(screen.getByLabelText("Your reply"));
      expect(replies).toEqual([]);
    }
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(replies).toEqual([{ action: "accept", content: { reply: "Scissors" } }]);
  });

  it("allows a free-form correction after choosing a button", () => {
    const replies: Reply[] = [];
    render(
      <ReplyForm
        prompt="Your move?"
        suggestions={["Paper", "Rock", "Scissors"]}
        onRespond={(reply) => replies.push(reply)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rock" }));
    fireEvent.change(screen.getByLabelText("Your reply"), { target: { value: "Actually, paper" } });
    fireEvent.keyDown(screen.getByLabelText("Your reply"), { key: "Enter", ctrlKey: true });
    expect(replies).toEqual([{ action: "accept", content: { reply: "Actually, paper" } }]);
  });

  it("disables options while waiting and removes them after the reply settles", () => {
    const replies: Reply[] = [];
    const { rerender } = render(
      <ReplyForm
        prompt="Your move?"
        suggestions={["Paper", "Rock", "Scissors"]}
        disabled
        onRespond={(reply) => replies.push(reply)}
      />,
    );
    for (const move of ["Paper", "Rock", "Scissors"]) {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: move }).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: move }));
    }
    expect(replies).toEqual([]);
    rerender(
      <ReplyForm
        prompt="Your move?"
        suggestions={["Paper", "Rock", "Scissors"]}
        response={{ action: "accept", content: { reply: "Paper" } }}
        onRespond={(reply) => replies.push(reply)}
      />,
    );
    expect(screen.queryByRole("button", { name: "Paper" })).toBeNull();
    expect(screen.getByText("Paper")).toBeTruthy();
  });
});
