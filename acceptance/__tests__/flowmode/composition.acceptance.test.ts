// @vitest-environment node
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { loadKernelProgram } from "@sweatpants/flowmode-backend";
import {
  compileReview,
  flowmodeLanguages,
  flowmodeStack,
  linkReview,
  useWorkflowKernel,
} from "../../support/flowmode.ts";

describe.each(flowmodeLanguages)("%s authored workflow", (language) => {
  it("compiles a developer tool, links an authored caller and restores suspended cleanup in fresh Wasm instances", async () => {
    await run(function* () {
      // Arrange: use public compilers, linker, bundle and real language runtime.
      const stack = flowmodeStack(language);
      const definition = yield* compileReview(stack.developerCompiler);
      expect(definition.exports[0]?.contract.name).toBe("review");
      const options = yield* linkReview(stack, definition);
      const program = stack.createProgram(options);
      expect(loadKernelProgram(program, program.manifest.digest)).toEqual(program.artifact);

      // Act: execute the caller until the compiled tool asks for approval.
      const first = yield* useWorkflowKernel(program);
      const waiting = yield* first.start(program.artifact, { title: "Ship the draft?" });
      expect(waiting.boundary).toMatchObject({
        kind: "suspended",
        request: {
          binding: JSON.stringify(["elicit", "approval"]),
          input: { message: "Ship the draft?" },
        },
      });
      const approvalSnapshot = JSON.parse(JSON.stringify(yield* waiting.execution.capture()));
      yield* first.close();

      // Act: a fresh instance restores the exact boundary without executing a step.
      const second = yield* useWorkflowKernel(program);
      const restored = yield* second.restore(program.artifact, approvalSnapshot);
      expect(restored.boundary).toMatchObject({
        kind: "suspended",
        request: { binding: JSON.stringify(["elicit", "approval"]) },
      });
      expect(JSON.parse(JSON.stringify(yield* restored.execution.capture()))).toEqual(
        approvalSnapshot,
      );
      if (restored.boundary.kind !== "suspended") {
        throw new Error("Expected approval");
      }
      const cleanup = yield* restored.execution.resume(restored.boundary.suspensionId, {
        kind: "value",
        value: { action: "accept", content: { approved: true } },
      });
      expect(cleanup).toMatchObject({
        kind: "suspended",
        request: {
          binding: JSON.stringify(["elicit", "cleanup"]),
          input: { message: "Release reservation?" },
        },
      });
      const cleanupSnapshot = JSON.parse(JSON.stringify(yield* restored.execution.capture()));
      yield* second.close();

      // Assert: even cleanup can suspend, survive replacement and return to its caller.
      const third = yield* useWorkflowKernel(program);
      try {
        const cleaning = yield* third.restore(program.artifact, cleanupSnapshot);
        expect(cleaning.boundary).toMatchObject({
          kind: "suspended",
          request: { binding: JSON.stringify(["elicit", "cleanup"]) },
        });
        expect(JSON.parse(JSON.stringify(yield* cleaning.execution.capture()))).toEqual(
          cleanupSnapshot,
        );
        if (cleaning.boundary.kind !== "suspended") {
          throw new Error("Expected cleanup");
        }
        expect(
          yield* cleaning.execution.resume(cleaning.boundary.suspensionId, {
            kind: "value",
            value: { action: "accept", content: { approved: true } },
          }),
        ).toEqual({ kind: "completed", value: "approved" });
      } finally {
        yield* third.close();
      }
    });
  });

  it("rejects changed artifacts and incompatible snapshots before execution", async () => {
    await run(function* () {
      // Arrange.
      const stack = flowmodeStack(language);
      const definition = yield* compileReview(stack.developerCompiler);
      const program = stack.createProgram(yield* linkReview(stack, definition));
      const first = yield* useWorkflowKernel(program);
      const waiting = yield* first.start(program.artifact, { title: "Pinned source" });
      const saved = yield* waiting.execution.capture();
      yield* first.close();

      // Act / Assert: content and snapshot identity are independent checks.
      const changed = {
        ...program,
        artifact: { ...program.artifact, code: "changed implementation" },
      };
      expect(() => loadKernelProgram(changed, program.manifest.digest)).toThrow(/digest/);
      const next = yield* useWorkflowKernel(program);
      try {
        let rejected: unknown;
        try {
          yield* next.restore(program.artifact, { ...saved, programDigest: "0".repeat(64) });
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(Error);
      } finally {
        yield* next.close();
      }
    });
  });
  it("preserves yielding cleanup across cancellation, repeated cancellation and restore", async () => {
    await run(function* () {
      // Arrange.
      const stack = flowmodeStack(language);
      const definition = yield* compileReview(stack.developerCompiler);
      const program = stack.createProgram(yield* linkReview(stack, definition));
      const first = yield* useWorkflowKernel(program);
      const approval = yield* first.start(program.artifact, { title: "Cancel this draft" });

      // Act: cancellation enters the compiled tool's authored cleanup.
      const cleanup = yield* approval.execution.cancel();
      expect(cleanup).toMatchObject({
        kind: "suspended",
        request: { binding: JSON.stringify(["elicit", "cleanup"]) },
      });
      expect(yield* approval.execution.cancel()).toEqual(cleanup);
      const saved = JSON.parse(JSON.stringify(yield* approval.execution.capture()));
      yield* first.close();

      // Assert: replacement cannot skip the pending cleanup or return a normal result.
      const second = yield* useWorkflowKernel(program);
      try {
        const restored = yield* second.restore(program.artifact, saved);
        const pending = yield* restored.execution.cancel();
        expect(pending).toMatchObject({
          kind: "suspended",
          request: { binding: JSON.stringify(["elicit", "cleanup"]) },
        });
        if (pending.kind !== "suspended") {
          throw new Error("Expected cancellation cleanup");
        }
        expect(
          yield* restored.execution.resume(pending.suspensionId, {
            kind: "value",
            value: { action: "accept", content: { approved: true } },
          }),
        ).toMatchObject({ kind: "cancelled" });
      } finally {
        yield* second.close();
      }
    });
  });

  it("reports invalid authored callers as compiler diagnostics", async () => {
    await run(function* () {
      // Arrange / Act: malformed source goes through the real language compiler.
      const stack = flowmodeStack(language);
      const result = yield* stack.compiler.compile({
        source: {
          id: "invalid-caller",
          language,
          text: language === "lua" ? "local =" : "(define (",
        },
        entry: "workflow",
        exports: [],
        bindings: [],
      });

      // Assert: failure contains actionable diagnostics and no executable module.
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "error", message: expect.any(String) }),
        ]),
      );
      expect(result).not.toHaveProperty("module");
    });
  });
});
