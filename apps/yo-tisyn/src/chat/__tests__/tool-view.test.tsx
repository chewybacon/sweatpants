// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactChatUIPart } from "@sweatpants/react-chat";
import type { Json } from "@sweatpants/foundation";
import { Part } from "../tool-view.tsx";
import { ReplyForm } from "../ask-plugin.tsx";
import type { Reply } from "../reply.tsx";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);

function completed(
  name: string,
  input: Json,
  output: Json,
  parts: ReactChatUIPart[] = [],
): ReactChatUIPart {
  return {
    type: "tool-call",
    id: "tool",
    callId: "call",
    name,
    state: "output-available",
    input,
    output,
    parts,
  };
}

describe("readable tool cards", () => {
  it("renders Scheme in the shared canvas with its original source", () => {
    const program = '(ask (object (cons "message" "Continue?")))';
    const { container } = render(<Part part={completed("scheme", { program }, "done")} />);
    expect(screen.getByLabelText("Expanded program canvas")).toBeTruthy();
    expect(screen.getByText("Scheme source")).toBeTruthy();
    expect(container.querySelector(".source code")?.textContent).toBe(program);
    expect(screen.queryByText("Expanded Tisyn")).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".logic-plan")?.open).toBe(true);
  });

  it("keeps authored macros visible separately from expanded Tisyn", () => {
    const program =
      'WithMacros({"Guard":{"params":["condition","action"],"body":If(Hole("condition"),Hole("action"),null)}},Use("Guard",true,"done"))';
    const { container } = render(<Part part={completed("tisyn", { program }, "done")} />);
    const sources = container.querySelectorAll(".source code");
    expect(sources[0]?.textContent).toBe(program);
    expect(sources[1]?.textContent).toContain("If(");
    expect(sources[1]?.textContent).not.toContain("WithMacros");
    expect(screen.getByText("Expanded Tisyn")).toBeTruthy();
  });

  it("shows echo text once, with labeled input collapsed and HTML treated as text", () => {
    const message = "<img src=x onerror=alert(1)>";
    const { container } = render(<Part part={completed("echo", { message }, { message })} />);
    expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    expect(container.querySelector("blockquote")?.textContent).toBe(message);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
  });

  it.each([false, true])(
    "shows one settled reply with local plugin present = %s",
    (pluginPresent) => {
      const response: Reply = { action: "accept", content: { reply: "hello world" } };
      const parts: ReactChatUIPart[] = pluginPresent
        ? [
            {
              type: "elicit",
              id: "elicit",
              elicitId: "elicit",
              bindingId: "binding",
              key: "reply",
              message: "What next?",
              state: "responded",
              parts: [
                {
                  type: "render",
                  id: "render",
                  parentElicitId: "elicit",
                  sequence: 0,
                  state: "completed",
                  node: (
                    <ReplyForm
                      prompt="What next?"
                      response={response}
                      onRespond={() => {
                        throw new Error("Already settled");
                      }}
                    />
                  ),
                },
              ],
            },
          ]
        : [];
      // A different child is not suppressed along with the reply interaction.
      parts.push({
        type: "render",
        id: "other",
        parentElicitId: "other",
        sequence: 0,
        state: "completed",
        node: <p>Other child content</p>,
      });
      const { container } = render(
        <Part part={completed("ask", { message: "What next?" }, response, parts)} />,
      );
      expect(screen.getAllByText("What next?")).toHaveLength(1);
      expect(screen.getAllByText("hello world")).toHaveLength(1);
      expect(container.querySelectorAll(".reply-outcome")).toHaveLength(1);
      expect(screen.getByText("Other child content")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
      expect(screen.getByText("Result data").closest("details")?.open).toBe(false);
    },
  );

  it.each([
    ["decline", "You declined this request."],
    ["cancel", "You cancelled this request."],
  ] as const)("renders %s as a human outcome", (action, text) => {
    render(<Part part={completed("ask", { message: "What next?" }, { action })} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("keeps the real reply form interactive while the tool is pending", () => {
    const responses: Reply[] = [];
    const { rerender } = render(
      <ReplyForm prompt="What next?" onRespond={(response) => responses.push(response)} />,
    );
    fireEvent.change(screen.getByLabelText("Your reply"), { target: { value: "next value" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(responses).toEqual([{ action: "accept", content: { reply: "next value" } }]);
    rerender(
      <ReplyForm prompt="What next?" disabled onRespond={(response) => responses.push(response)} />,
    );
    fireEvent.click(screen.getByText("Other options"));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(responses).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>("Your reply").disabled).toBe(true);
  });

  it("keeps unknown output shapes visible rather than guessing a specialized reply", () => {
    render(
      <Part
        part={completed(
          "ask",
          { message: "Question" },
          { action: "accept", content: { unexpected: true } },
        )}
      />,
    );
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText(/"unexpected": true/)).toBeTruthy();
  });

  it("retains errors and invalid source without crashing the conversation", () => {
    const { container } = render(
      <Part
        part={{
          type: "tool-call",
          id: "tool",
          callId: "call",
          name: "tisyn",
          state: "output-error",
          input: { program: "Let(" },
          errorText: "Program rejected",
          parts: [],
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Program rejected");
    expect(screen.getByText(/Program source cannot be diagrammed/)).toBeTruthy();
    expect(screen.getByText("Let(")).toBeTruthy();
    expect(container.querySelector(".source")?.hasAttribute("open")).toBe(false);
  });
});

it.each(["display_document", "present_choices"])(
  "restores a settled %s snapshot after local UI is lost",
  (name) => {
    const part = completed(name, {}, { status: "displayed" }, [
      {
        type: "elicit",
        id: "saved",
        elicitId: "saved",
        bindingId: "binding",
        key: name === "display_document" ? "display" : "choose",
        message: "Saved presentation",
        state: "responded",
        parts: [],
        context: {
          context: {
            message: "Saved presentation",
            choices: [
              { id: "a", label: "Alpha" },
              { id: "b", label: "Beta" },
            ],
            layout: "grid",
            columns: 2,
          },
          documents: {
            content: {
              current: {
                document: { id: "doc" },
                name: "My document",
                revision: 3,
                content: { history: ["first", "second"] },
              },
              changes: { kind: "reset" },
            },
          },
        },
      },
    ]);
    const { container, rerender } = render(<Part part={part} />);
    expect(screen.getAllByText("Saved presentation")).toHaveLength(1);
    expect(screen.getByText("My document")).toBeTruthy();
    expect(container.querySelector(".document-content")?.textContent).toContain('"second"');
    const cells = screen.getAllByRole<HTMLButtonElement>("button");
    expect(cells).toHaveLength(2);
    expect(cells.every((cell) => cell.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    rerender(<Part part={part} />);
    expect(screen.getAllByText("Saved presentation")).toHaveLength(1);
  },
);

it("preserves other child content when a saved document context cannot be decoded", () => {
  render(
    <Part
      part={completed("display_document", {}, { status: "displayed" }, [
        {
          type: "elicit",
          id: "saved",
          elicitId: "saved",
          bindingId: "binding",
          key: "display",
          message: "Old view",
          state: "responded",
          context: {},
          parts: [
            {
              type: "render",
              id: "fallback",
              parentElicitId: "saved",
              sequence: 0,
              state: "completed",
              node: <p>Retained content</p>,
            },
          ],
        },
      ])}
    />,
  );
  expect(screen.getByText("Retained content")).toBeTruthy();
});
