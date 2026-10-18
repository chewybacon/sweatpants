import { describe, it, expect } from "vitest";
import { run } from "effection";
import { createNodeSchemeDriver } from "../node.ts";

describe("Scheme engine", () => {
  it("validates without invoking effects and preserves reader diagnostics", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      expect(yield* driver.validate('(ask (object (cons "message" "Hello?")))')).toEqual({
        valid: true,
      });
      const invalid = yield* driver.validate("(let ((x 1))");
      expect(invalid.valid).toBe(false);
      if (!invalid.valid) {
        expect(invalid.message).toMatch(/end of input|read/i);
      }
    });
  });
  it("runs tail calls, and/or, lexical callbacks and immutable JSON updates", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(let ((prefix "hi"))
    (let loop ((n 10000))
      (if (and (= n 0) (or #f #t))
        (object-set (object (cons "hello" ((lambda (x) (string-append prefix x)) "!")))
          "values" (array-append (array (json-null) #f 0) 42))
        (loop (- n 1)))))`,
        capabilities: [],
      });
      expect(yield* driver.advance(handle)).toEqual({
        done: true,
        value: { hello: "hi!", values: [null, false, 0, 42] },
      });
    });
  });
  it("recognizes conditional auxiliary bindings", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(array (cond (#f 1) (else 2))
          (case "paper" (("rock") 1) (else 3))
          (cond ((+ 1 2) => (lambda (x) (+ x 1))) (else 0))
          (let-syntax ((many (syntax-rules () ((_ x ...) (array x ...))))) (many 5 6)))`,
        capabilities: [],
      });
      expect(yield* driver.advance(handle)).toEqual({ done: true, value: [2, 3, 4, [5, 6]] });
    });
  });
  it("with-reply resumes with content and exchange", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(with-reply (object (cons "message" "Name?"))
     (lambda (content exchange) (field content "reply")) (lambda (stop) stop))`,
        capabilities: ["ask"],
      });
      expect(yield* driver.advance(handle)).toEqual({
        done: false,
        value: { id: "ask", data: { message: "Name?" } },
      });
      expect(
        yield* driver.advance(handle, {
          action: "accept",
          content: { reply: "Ada" },
          exchange: { messages: [] },
        }),
      ).toEqual({ done: true, value: "Ada" });
    });
  });
  it("quoted child invocation carries source and explicit input", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(invoke '(field input "name") (object (cons "name" "Ada")))`,
        capabilities: ["scheme.invoke"],
      });
      expect(yield* driver.advance(handle)).toEqual({
        done: false,
        value: {
          id: "scheme.invoke",
          data: { program: '(field input "name")', input: { name: "Ada" } },
        },
      });
      expect(yield* driver.advance(handle, "Ada")).toEqual({ done: true, value: "Ada" });
    });
  });
  it("denies unavailable effects and invalidates failed handles", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({ source: '(effect "shell" (object))', capabilities: [] });
      expect(() => driver.advance(handle)[Symbol.iterator]().next()).toThrow(/capability denied/);
      expect(() => driver.advance(handle)[Symbol.iterator]().next()).toThrow(/closed/);
      yield* driver.close(handle);
    });
  });
  it("fuel traps remain outside authored exception handling", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({ source: "(let loop () (loop))", capabilities: [] });
      expect(() => driver.advance(handle)[Symbol.iterator]().next()).toThrow(/fuel exhausted/);
      expect(() => driver.advance(handle)[Symbol.iterator]().next()).toThrow(/closed/);
    });
  });
});
