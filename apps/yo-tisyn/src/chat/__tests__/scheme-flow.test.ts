import { describe, expect, it } from "vitest";
import { createSchemeFlow } from "../scheme-flow.ts";
import { layoutFlow } from "../program-layout.ts";

describe("Scheme continuation canvas", () => {
  it("distills pure bindings and score arithmetic but retains nested yields", () => {
    const flow = createSchemeFlow(`(let* ((score (+ 1 (if #t 1 0)))
      (answer (ask (object (cons "message" "Next?")))))
      (echo (object (cons "message" (field answer "action")))))`);
    expect(
      flow.nodes
        .filter((n) => n.kind === "yield")
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Ask", "Echo"]);
    expect(flow.nodes.filter((n) => n.kind === "branch")).toHaveLength(0);
    const ask = flow.nodes.find((n) => n.title === "Ask")!;
    const echo = flow.nodes.find((n) => n.title === "Echo")!;
    expect(flow.edges).toContainEqual({ source: ask.id, target: echo.id, label: undefined });
  });
  it("distills pure helper branches without losing effects in their arguments", () => {
    const flow =
      createSchemeFlow(`(letrec ((label (lambda (x) (cond ((equal? x "a") "A") (else "B")))))
      (echo (object (cons "message" (label (random input))))))`);
    expect(flow.nodes.filter((n) => n.kind === "branch")).toHaveLength(0);
    expect(
      flow.nodes
        .filter((n) => n.kind === "yield")
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Echo", "Random"]);
  });
  it("projects reply continuations and closes a named tail loop", () => {
    const flow = createSchemeFlow(
      `(let loop ((score 0))
      (with-reply (object (cons "message" "Again?"))
        (lambda (content exchange) (random (object (cons "choices" (array "a" "b")))) (loop (+ score 1)))
        (lambda (stopped) stopped)))`,
    );
    const ask = flow.nodes.find((n) => n.title === "Ask")!;
    expect(
      flow.edges
        .filter((e) => e.source === ask.id)
        .map((e) => e.label)
        .sort(),
    ).toEqual(["accepted", "declined / cancelled"]);
    expect(layoutFlow(flow).nodes.some((n) => n.type === "loop")).toBe(true);
  });
  it("shows a single completion for case paths", () => {
    const flow = createSchemeFlow(
      `(case (field input "choice") (("a") (ask input)) (("b") (random input)) (else "done"))`,
    );
    expect(flow.nodes.filter((n) => n.kind === "exit")).toHaveLength(1);
    expect(flow.nodes.some((n) => n.title === "Random" && n.origin === "builtin")).toBe(true);
    expect(flow.nodes.some((n) => n.title === "Ask" && n.origin === "authored")).toBe(true);
  });
  it("does not execute quoted child effects in the parent projection", () => {
    const flow = createSchemeFlow(`(invoke '(ask input) (json-null))`);
    expect(flow.nodes.filter((n) => n.kind === "yield").map((n) => n.title)).toEqual([
      "Invoke child",
    ]);
  });
  it("shows macro scope as opaque rather than guessing its expansion", () => {
    const flow = createSchemeFlow(
      `(let-syntax ((twice (syntax-rules () ((_ x) (begin x x))))) (twice (ask input)))`,
    );
    expect(flow.nodes.filter((n) => n.kind === "yield")).toHaveLength(0);
    expect(flow.nodes.find((n) => n.kind === "call")?.caption).toContain("Runtime structure");
  });
  it("resolves lexical helper functions and respects shadowed builtin names", () => {
    const flow = createSchemeFlow(`(let ((ask (lambda (x) (effect "echo" x)))) (ask input))`);
    expect(flow.nodes.filter((n) => n.kind === "yield").map((n) => n.title)).toEqual(["Echo"]);
  });
  it("keeps cond receiver calls visible as runtime structure", () => {
    const flow = createSchemeFlow("(cond (#t => (lambda (x) (ask input))))");
    expect(flow.nodes.some((n) => n.kind === "call")).toBe(true);
  });
  it("respects lexically shadowed control forms", () => {
    const flow = createSchemeFlow("(let ((if (lambda (x) (ask x)))) (if input))");
    expect(flow.nodes.some((n) => n.title === "Ask")).toBe(true);
    expect(flow.nodes.some((n) => n.kind === "branch")).toBe(false);
  });
  it("handles comments and parentheses inside escaped strings", () => {
    const flow = createSchemeFlow(String.raw`; before
(ask (object (cons "message" "Say \"hi\" (now)")))`);
    expect(flow.nodes.some((n) => n.title === "Ask")).toBe(true);
  });
  it.each(["(", '(ask "unfinished)', "(ask input) (random input)", "#;(ask input)"])(
    "rejects incomplete or unsupported reader syntax: %s",
    (source) => {
      expect(() => createSchemeFlow(source)).toThrow();
    },
  );
});

it("shows match-result branches after the single yielded effect", () => {
  const flow = createSchemeFlow(`(match-result (ask (object (cons "message" "Next?"))) "action"
    ("accept" reply (sample (object (cons "prompt" "Continue"))))
    (else stopped stopped))`);
  expect(flow.nodes.filter((n) => n.title === "Ask")).toHaveLength(1);
  const branch = flow.nodes.find((n) => n.title === "Result: action")!;
  expect(
    flow.edges
      .filter((e) => e.source === branch.id)
      .map((e) => e.label)
      .sort(),
  ).toEqual(["accept", "else"]);
  expect(flow.nodes.some((n) => n.title === "Sample")).toBe(true);
});
