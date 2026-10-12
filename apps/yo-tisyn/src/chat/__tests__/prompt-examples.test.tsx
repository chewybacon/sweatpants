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
      "Quiz me on capitals",
      "Quiz me on world capitals, one question at a time. Let's do three questions. Tell me whether each answer is right, explain any mistakes, and give me my score at the end.",
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
