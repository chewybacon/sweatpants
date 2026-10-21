import { describe, expect, it } from "vitest";
import { run } from "effection";
import { createNodeSchemeDriver } from "../node.ts";

describe("match-result", () => {
  it("exposes Scheme ellipsis and wildcard bindings for authored macros", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(let-syntax
          ((many (syntax-rules () ((_ item ...) (array item ...))))
           (ignore (syntax-rules () ((_ _ _) 42))))
          (array (many) (many 1) (many 1 2 3) (ignore 10 20)))`,
        capabilities: [],
      });
      expect(yield* driver.advance(handle)).toEqual({
        done: true,
        value: [[], [1], [1, 2, 3], 42],
      });
    });
  });

  it("evaluates the effect and tag once, runs only the chosen branch, and preserves hygiene", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(let ((value "outer") (tag-value "outside"))
          (match-result (ask (object (cons "message" "Pick?")))
            (ask (object (cons "message" "Field?")))
            ("accept" reply (array value tag-value (field reply "content")))
            ("cancel" reply (ask (object (cons "message" "Unselected"))))
            (else other other)))`,
        capabilities: ["ask"],
      });
      expect(yield* driver.advance(handle)).toMatchObject({
        done: false,
        value: { id: "ask", data: { message: "Pick?" } },
      });
      expect(yield* driver.advance(handle, { action: "accept", content: 42 })).toMatchObject({
        done: false,
        value: { data: { message: "Field?" } },
      });
      expect(yield* driver.advance(handle, "action")).toEqual({
        done: true,
        value: ["outer", "outside", 42],
      });
    });
  });
  it("returns unmatched results to the explicit fallback", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(match-result input "status"
        ("ok" result (field result "parsed")) (else other other))`,
        input: { status: "refused" },
        capabilities: [],
      });
      expect(yield* driver.advance(handle)).toEqual({ done: true, value: { status: "refused" } });
    });
  });
  it("keeps tail calls in branch bodies", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      const handle = yield* driver.open({
        source: `(let loop ((n 1000))
        (match-result (object (cons "status" "ok")) "status"
          ("ok" result (if (= n 0) n (loop (- n 1))))
          (else other other)))`,
        capabilities: [],
      });
      expect(yield* driver.advance(handle)).toEqual({ done: true, value: 0 });
    });
  });
  it("requires a fallback and a body in each branch", async () => {
    await run(function* () {
      const driver = createNodeSchemeDriver();
      for (const source of [
        '(match-result input "status" ("ok" result result))',
        '(match-result input "status" ("ok" result) (else other other))',
      ]) {
        expect((yield* driver.validate(source)).valid).toBe(false);
      }
    });
  });
});
