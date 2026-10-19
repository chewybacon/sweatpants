import { describe, expect, it } from "vitest";
import { schemeSourceHint } from "../diagnostics.ts";

describe("Scheme source hints", () => {
  it("locates an unmatched opening in the submitted source", () => {
    expect(schemeSourceHint("(let ()\n  (define (f) 1)\n  (f)")).toContain("line 1, column 1");
  });
  it("locates unexpected closing parentheses", () => {
    expect(schemeSourceHint("(let ()\n  1))")).toContain("line 2, column 5");
  });
  it("points to separate outer lists without declaring them invalid", () => {
    expect(schemeSourceHint("(define (f) 1)\n(f)")).toContain("outermost lists close");
  });
  it("ignores delimiters in strings, escaped quotes and line comments", () => {
    expect(schemeSourceHint('(list "(\\\")" ; )\n #t #f)')).toBeUndefined();
  });
  it("identifies an unclosed string", () => {
    expect(schemeSourceHint('(list "hello')).toContain(
      "Unclosed string starting at line 1, column 7",
    );
  });
  it("leaves reader extensions to Hoot", () => {
    for (const source of ["#; (ignored) (ok)", "#\\( ", "#| ( |#", "#(1)", "|symbol)|", "#true"]) {
      expect(schemeSourceHint(source)).toBeUndefined();
    }
  });
  it("does not diagnose balanced code or quoted code", () => {
    expect(schemeSourceHint("(let () (define (f x) x) (f '(a b)))")).toBeUndefined();
  });
});
