import { expect, it } from "vitest";
import { run } from "effection";
import { createMontyKernel, montyIdentity } from "@sweatpants/flowmode-runtime-monty";
import { loadMontyModule } from "@sweatpants/flowmode-runtime-monty/node";
import type { Json } from "@sweatpants/foundation";
import { demoSource, cleanupSource, errorSource } from "@sweatpants/flowmode-runtime-monty/guest";
import { z } from "zod";
const requests = z.object({
  operations: z.array(
    z.object({
      id: z.number(),
      label: z.string(),
      request: z.object({
        capability: z.literal("sandbox.read_file"),
        arguments: z.object({ path: z.string() }),
      }),
    }),
  ),
});

it("imports real sandbox aliases and catches host exceptions with ordinary Python", async () => {
  const program = {
    kernel: montyIdentity,
    digest: "error-authoring",
    code: errorSource,
  };
  await run(function* () {
    let kernel = createMontyKernel(loadMontyModule);
    try {
      let state = yield* kernel.start(program, null);
      const snapshot = yield* state.execution.capture();
      yield* kernel.close();
      kernel = createMontyKernel(loadMontyModule);
      state = yield* kernel.restore(program, snapshot);
      if (state.boundary.kind !== "suspended") {
        throw Error("Expected read");
      }
      const op = requests.parse(state.boundary.request.input).operations[0];
      expect(op.request.arguments.path).toBe("missing.txt");
      let boundary = yield* state.execution.resume(state.boundary.suspensionId, {
        kind: "value",
        value: {
          operationId: op.id,
          error: { type: "FileNotFoundError", message: "not supplied" },
        },
      });
      if (boundary.kind !== "suspended") {
        throw Error("Expected recovery read");
      }
      const next = requests.parse(boundary.request.input).operations[0];
      expect(next.request.arguments.path).toBe("a.txt");
      boundary = yield* state.execution.resume(boundary.suspensionId, {
        kind: "value",
        value: { operationId: next.id, value: "alpha" },
      });
      expect(boundary).toEqual({ kind: "completed", value: ["not supplied", "alpha"] });
    } finally {
      yield* kernel.close();
    }
  });
});

it("restores cancellation through ordinary finally and async with yielding reads", async () => {
  const program = { kernel: montyIdentity, digest: "cleanup-authoring", code: cleanupSource };
  await run(function* () {
    let kernel = createMontyKernel(loadMontyModule);
    try {
      let state = yield* kernel.start(program, null);
      if (state.boundary.kind !== "suspended") {
        throw Error("Expected reads");
      }
      expect(
        requests
          .parse(state.boundary.request.input)
          .operations.map((op) => op.request.arguments.path),
      ).toEqual(["a.txt", "b.txt"]);
      state = { ...state, boundary: yield* state.execution.cancel("stop") };
      const seen: string[] = [];
      while (state.boundary.kind === "suspended") {
        const before = requests.parse(state.boundary.request.input).operations;
        const snapshot = yield* state.execution.capture();
        yield* kernel.close();
        kernel = createMontyKernel(loadMontyModule);
        state = yield* kernel.restore(program, snapshot);
        if (state.boundary.kind !== "suspended") {
          throw Error("Expected cleanup");
        }
        expect(requests.parse(state.boundary.request.input).operations).toEqual(before);
        const repeated = yield* state.execution.cancel("again");
        expect(repeated).toEqual(state.boundary);
        const op = before[before.length - 1];
        seen.push(op.request.arguments.path);
        state = {
          ...state,
          boundary: yield* state.execution.resume(state.boundary.suspensionId, {
            kind: "value",
            value: { operationId: op.id, value: "clean" },
          }),
        };
      }
      expect(seen.slice(0, 2).toSorted()).toEqual(["cleanup-a.txt", "cleanup-b.txt"]);
      expect(seen[2]).toBe("session-cleanup.txt");
      expect(state.boundary.kind).toBe("cancelled");
    } finally {
      yield* kernel.close();
    }
  });
});

it.each(["oversized value", "oversized error", "disallowed exception", "unknown ID", "stale ID"])(
  "rejects %s before mutation and completes the same restored execution",
  async (invalid) => {
    const program = { kernel: montyIdentity, digest: "reply-preflight", code: demoSource };
    await run(function* () {
      let kernel = createMontyKernel(loadMontyModule);
      try {
        let state = yield* kernel.start(program, null);
        const snapshot = yield* state.execution.capture();
        yield* kernel.close();
        kernel = createMontyKernel(loadMontyModule);
        state = yield* kernel.restore(program, snapshot);
        let boundary = state.boundary;
        if (boundary.kind !== "suspended") {
          throw Error("Expected five reads");
        }
        const operations = requests.parse(boundary.request.input).operations;
        expect(operations.map((op) => op.request.arguments.path)).toEqual([
          "a.txt",
          "b.txt",
          "c.txt",
          "d.txt",
          "e.txt",
        ]);
        const settled = operations[4];
        boundary = yield* state.execution.resume(boundary.suspensionId, {
          kind: "value",
          value: { operationId: settled.id, value: "e.txt" },
        });
        if (boundary.kind !== "suspended") {
          throw Error("Expected remaining reads");
        }
        const operationId = operations[3].id;
        const invalidReplies: Record<string, Json> = {
          "oversized value": { operationId, value: "x".repeat(12001) },
          "oversized error": {
            operationId,
            error: { type: "ValueError", message: "x".repeat(12001) },
          },
          "disallowed exception": {
            operationId,
            error: { type: "TypeError", message: "outside allowlist" },
          },
          "unknown ID": {
            operationId: Math.max(...operations.map((op) => op.id)) + 1000,
            value: "unknown",
          },
          "stale ID": { operationId: settled.id, value: "already settled" },
        };
        const before = yield* state.execution.capture();
        let rejection: unknown;
        try {
          yield* state.execution.resume(boundary.suspensionId, {
            kind: "value",
            value: invalidReplies[invalid],
          });
        } catch (error) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toBe(
          "Reply must select a currently outstanding operation",
        );
        expect(yield* state.execution.capture()).toEqual(before);
        // No restore or replacement after rejection: retain this handle and suspension.
        for (const op of operations.slice(0, 4).toReversed()) {
          if (boundary.kind !== "suspended") {
            throw Error("Expected remaining read");
          }
          boundary = yield* state.execution.resume(boundary.suspensionId, {
            kind: "value",
            value: { operationId: op.id, value: op.request.arguments.path },
          });
        }
        expect(boundary).toEqual({
          kind: "completed",
          value: ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"],
        });
      } finally {
        yield* kernel.close();
      }
    });
  },
);
