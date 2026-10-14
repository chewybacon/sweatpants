// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptExamples } from "../prompt-examples.tsx";

afterEach(cleanup);

describe("empty conversation examples", () => {
  it.each([
    [
      "Plan a get-together",
      "Help me collect RSVPs for Alex, Sam, and Jo. Ask me about one person at a time. If they're coming, ask what they'd like to eat; if not, move on. At the end, give me a guest list and the meal orders.",
    ],
    [
      "Play Bulls and Cows",
      "Let's play Bulls and Cows. I'm thinking of a four-digit number with no repeated digits and no leading zero. You guess; I'll tell you the bulls and cows. Keep track of our guesses until you solve it.",
    ],
    [
      "Name my bookstore",
      "Help me find a name for a cozy neighborhood bookstore. Suggest one name at a time and ask what I think. If I don't like it, use my feedback to improve the next suggestion. When I pick one, give me the name and a short tagline.",
    ],
  ])("selects %s without submitting", (title, prompt) => {
    const select = vi.fn<(prompt: string) => void>();
    const submit = vi.fn<(event: FormEvent<HTMLFormElement>) => void>((event) =>
      event.preventDefault(),
    );
    render(
      <form onSubmit={submit}>
        <PromptExamples onSelect={select} />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: new RegExp(title) }));
    expect(select).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(submit).not.toHaveBeenCalled();
  });
});
