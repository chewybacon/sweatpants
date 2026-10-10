// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptExamples } from "../prompt-examples.tsx";

afterEach(cleanup);

describe("empty conversation examples", () => {
  it.each([
    [
      "Loop until I decline",
      "ask me for input in a loop until I decline, echo the accumulated response as it goes",
    ],
    [
      "Combine two replies",
      "Ask me for two words, then echo them joined with a space. Stop if I decline or cancel.",
    ],
    ["Try a simple echo", 'Echo "hello world" using one Tisyn program.'],
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
